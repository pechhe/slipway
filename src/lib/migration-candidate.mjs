/** Late-bound migration source belongs to the shared, serialized landing path. */
import { readFile, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.mjs";
import { verificationSlotEnvironment } from "./verification-slot.mjs";

const safePath = (value) => {
  if (typeof value !== "string" || !value || value.includes("\\") || value.startsWith("/") || value.split("/").some(part => !part || part === "." || part === ".."))
    throw new Error("Unsafe migration policy path");
  return value;
};
const command = (value) => {
  if (!value || typeof value.executable !== "string" || !/^[A-Za-z0-9._+-]+$/.test(value.executable) || !Array.isArray(value.args) || value.args.some(arg => typeof arg !== "string" || arg.length > 32000))
    throw new Error("Invalid migration command");
  return { executable: value.executable, args: value.args, cwd: value.cwd == null ? null : safePath(value.cwd) };
};
const paths = value => {
  if (!Array.isArray(value) || !value.length || value.length > 50) throw new Error("Invalid migration policy paths");
  return [...new Set(value.map(safePath))];
};
export async function readMigrationPolicy(root) {
  const source = await readFile(join(root, ".peach/execution.json"), "utf8").catch(error => {
    if (error.code === "ENOENT") return null;
    throw error;
  });
  if (source === null) return null;
  if (Buffer.byteLength(source) > 65536) throw new Error("Migration policy exceeds source budget");
  const policy = JSON.parse(source);
  const row = policy?.migrationFinalization;
  if (row == null) return null;
  if (policy.version !== 1) throw new Error("Invalid execution policy version");
  if (row.mode !== "late_bound_serialized") throw new Error("Invalid migration finalization mode");
  return { mode: row.mode, triggerPaths: paths(row.triggerPaths), artifactPaths: paths(row.artifactPaths), generate: command(row.generate), verify: command(row.verify) };
}
const matches = (roots, file) => roots.some(root => file === root || file.startsWith(root + "/"));
const changedPaths = summary => summary.split(/\r?\n/).filter(Boolean).map(line => line.replace(/^[A-Z?]\s+/, ""));

/** Called inside the shared verification slot, before the final rebase and held
 * through generation, verification and integration by the caller. No second lease. */
export async function migrationCandidate(cwd, context, io, options = {}) {
  const policy = await readMigrationPolicy(context.integration.root);
  let generated = null;
  return {
    async finalize(candidate, base) {
      if (!policy) return candidate;
      const semanticPaths = changedPaths(await io.jj(cwd, ["diff", "--from", base.commitId, "--to", candidate.commitId, "--summary"]));
      if (!semanticPaths.some(file => matches([...policy.triggerPaths, ...policy.artifactPaths], file))) return candidate;
      if (semanticPaths.some(file => matches(policy.artifactPaths, file))) throw new Error("Late-bound migration artifacts must be generated during landing, not committed in the semantic candidate");
      // The candidate may be @- below an empty child; generation must edit it.
      const originalWorkingCopy = await io.revisionFacts(cwd, "@");
      generated = { semantic: candidate, originalWorkingCopy, finalized: null, base };
      await io.jj(cwd, ["edit", candidate.changeId]);
      const run = async declaration => {
        const root = await realpath(context.current.root);
        const commandRoot = await realpath(resolve(root, declaration.cwd ?? "."));
        if (commandRoot !== root && !commandRoot.startsWith(root + sep)) throw new Error("Migration command cwd escapes workspace");
        options.onProgress?.(`[migration] ${declaration.executable} ${declaration.args.join(" ")}`);
        const result = await (options.runCommand ?? runBoundedProcess)({ ...declaration, cwd: commandRoot, timeoutMs: 3600000, maxOutputBytes: 65536, env: verificationSlotEnvironment((options.environment ?? sanitizedProcessEnv)()) });
        if (result.exitCode !== 0 || result.timedOut || result.cancelled || result.signal || result.error)
          throw new Error("Migration finalization command " + declaration.executable + " " + declaration.args.join(" ") + " " + (result.timedOut ? "timed out" : result.cancelled ? "was cancelled" : result.signal ? "was terminated" : result.error ? "could not start" : "exited with code " + result.exitCode));
      };
      try {
        await run(policy.generate);
        await io.jj(cwd, ["status"]);
        await run(policy.verify);
        const finalized = await io.revisionFacts(cwd, candidate.changeId);
        const resultPaths = changedPaths(await io.jj(cwd, ["diff", "--from", base.commitId, "--to", finalized.commitId, "--summary"]));
        if (!resultPaths.some(file => matches(policy.artifactPaths, file))) throw new Error("Migration generator produced no declared artifacts");
        const unexpected = resultPaths.filter(file => !semanticPaths.includes(file) && !matches(policy.artifactPaths, file));
        if (unexpected.length) throw new Error("Migration generation changed undeclared paths: " + unexpected.join(", "));
        generated.finalized = finalized;
        return finalized;
      } catch (error) {
        generated.finalized = await io.revisionFacts(cwd, candidate.changeId);
        throw error;
      }
    },
    async rollback() {
      if (!generated) return;
      const { semantic, finalized, originalWorkingCopy } = generated;
      if ((await io.revisionFacts(cwd, context.integrationBranch)).commitId === finalized?.commitId) return;
      const current = await io.revisionFacts(cwd, semantic.changeId);
      if (!finalized || current.commitId !== finalized.commitId)
        throw new Error("Migration candidate changed after generation; preserve it for reconciliation");
      // Restore only this candidate's tree. Never rewind the shared JJ operation log.
      await io.jj(cwd, ["restore", "--from", semantic.commitId, "--into", semantic.changeId]);
      if (originalWorkingCopy.changeId !== semantic.changeId) await io.jj(cwd, ["edit", originalWorkingCopy.changeId]);
    }
  };
}
