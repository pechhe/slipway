/** Late-bound migration source belongs to the shared, serialized landing path. */
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.mjs";
import { checkoutCwd } from "./checkout-cwd.mjs";
import { verificationSlotEnvironment } from "./verification-slot.mjs";

const matches = (roots, file) => roots.some(root => file === root || file.startsWith(root + "/"));
const changedPaths = summary => summary.split(/\r?\n/).filter(Boolean).map(line => line.replace(/^[A-Z?]\s+/, ""));

/** Called inside the shared verification slot, before the final rebase and held
 * through generation, verification and integration by the caller. No second lease. */
export async function migrationCandidate(cwd, context, io, options = {}) {
  // Parsed from the integration bookmark's committed policy (see execution-policy).
  const policy = context.configuration.migrationFinalization ?? null;
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
        const commandRoot = await checkoutCwd(context.current.root, declaration.cwd, "Migration command");
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
