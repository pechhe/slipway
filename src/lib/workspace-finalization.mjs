import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runBoundedProcess } from "./bounded-process.mjs";
import { parseWorkspaceList, workspaceContext } from "./peach-workspace.mjs";
import { finalizePostIntegration } from "./post-integration-finalization.mjs";

async function jj(cwd, args) {
  const result = await runBoundedProcess({ executable: "jj", args: ["--ignore-working-copy", "--color=never", ...args],
    cwd, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.signal || result.error || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error("Cannot prove the exact integrated JJ artifact");
  }
  return result.stdout.trim();
}

/** Native Pi retries only external finalization, never source landing or primary checkout synchronization. */
export async function finalizeIntegratedWorkspace(cwd, options) {
  const expected = options?.expectedCommitSha;
  if (typeof expected !== "string" || !/^[a-f0-9]{40}$/.test(expected)) throw new Error("An exact landed commit is required");
  const root = await jj(cwd, ["workspace", "root"]);
  const workspaces = parseWorkspaceList(await jj(cwd, ["workspace", "list", "-T",
    'name ++ "\t" ++ root ++ "\t" ++ target.change_id() ++ "\t" ++ target.commit_id() ++ "\n"']));
  const current = workspaces.find((entry) => entry.root && resolve(entry.root) === resolve(root));
  if (!current || current.name === "default") throw new Error("Finalization requires the retained Issue workspace");
  const state = JSON.parse(await readFile(join(homedir(), ".pi", "agent", "workspace-state", `${current.name}.json`), "utf8"));
  if (!state || state.phase !== "landed" || state.workspaceName !== current.name || state.artifactCommitId !== expected
    || state.workspacePath !== root || typeof state.integrationBranch !== "string"
    || !["passed", "passed_with_gaps"].includes(state.verification)) throw new Error("Exact landed delivery evidence is missing");
  const context = await workspaceContext(cwd, state.integrationBranch);
  if (!context || context.integration.root !== state.integrationRoot) throw new Error("Integrated repository identity changed");
  const proof = await jj(cwd, ["log", "-r", `${expected} & ::${state.integrationBranch}`, "--no-graph", "-T", 'commit_id ++ "\t" ++ change_id ++ "\t" ++ conflict']);
  if (proof !== `${expected}\t${state.artifactChangeId}\tfalse`) throw new Error("Artifact is no longer integrated exactly");
  return finalizePostIntegration({
    gitDirectory: await jj(cwd, ["git", "root"]), integratedCommitSha: expected,
    approval: options.approval, inspectOnly: options.inspectOnly === true, abortSignal: options.abortSignal,
    readIntegrationTip: () => jj(cwd, ["log", "-r", state.integrationBranch, "--no-graph", "-T", "commit_id"]),
  });
}
