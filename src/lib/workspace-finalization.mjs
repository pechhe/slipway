import { mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { runBoundedProcess } from "./bounded-process.mjs";
import { parseWorkspaceList, workspaceContext } from "./peach-workspace.mjs";
import { finalizePostIntegration } from "./post-integration-finalization.mjs";
import { finalizeSourcePublication } from "./source-publication.mjs";
import { publicationDigest } from "./source-publication-io.mjs";
import { writeWorkspaceJson } from "./workspace-transaction.mjs";

async function jj(cwd, args) {
  const result = await runBoundedProcess({ executable: "jj", args: ["--ignore-working-copy", "--color=never", ...args],
    cwd, timeoutMs: 30_000, maxOutputBytes: 64 * 1024 });
  if (result.exitCode !== 0 || result.timedOut || result.signal || result.error || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error("Cannot prove the exact integrated JJ artifact");
  }
  return result.stdout.trim();
}

const artifactDirectory = join(homedir(), ".pi", "agent", "workspace-state", "landed");

/** Retain proven landing evidence independently of the disposable working directory. */
export async function archiveIntegratedWorkspaceEvidence(gitDirectory, state) {
  const file = join(artifactDirectory, "artifact-" + publicationDigest([await realpath(gitDirectory), state.artifactCommitId]) + ".json");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  try {
    const previous = JSON.parse(await readFile(file, "utf8"));
    if (previous.workspaceName !== state.workspaceName || previous.integrationRoot !== state.integrationRoot
      || previous.artifactCommitId !== state.artifactCommitId || previous.artifactChangeId !== state.artifactChangeId
      || previous.integrationBranch !== state.integrationBranch || previous.issueNumber !== state.issueNumber) {
      throw new Error("Archived integrated delivery identity changed");
    }
    return;
  } catch (error) { if (error?.code !== "ENOENT") throw error; }
  await writeWorkspaceJson(file, { ...state, phase: "landed" });
}

/** Return null only when no retained evidence exists; corrupt or mismatched evidence fails closed. */
export async function readIntegratedWorkspaceEvidence(cwd, expected) {
  if (typeof expected !== "string" || !/^[a-f0-9]{40}$/.test(expected)) throw new Error("An exact landed commit is required");
  const root = await jj(cwd, ["workspace", "root"]);
  const gitDirectory = await realpath(await jj(cwd, ["git", "root"]));
  const workspaces = parseWorkspaceList(await jj(cwd, ["workspace", "list", "-T",
    'name ++ "\t" ++ root ++ "\t" ++ target.change_id() ++ "\t" ++ target.commit_id() ++ "\n"']));
  const current = workspaces.find((entry) => entry.root && resolve(entry.root) === resolve(root));
  if (!current) throw new Error("Current JJ workspace identity is missing");
  const file = current.name === "default"
    ? join(artifactDirectory, "artifact-" + publicationDigest([gitDirectory, expected]) + ".json")
    : join(homedir(), ".pi", "agent", "workspace-state", current.name + ".json");
  let state;
  try { state = JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
  if (!state || !["prepared", "landed"].includes(state.phase) || state.artifactCommitId !== expected
    || typeof state.integrationBranch !== "string" || !["passed", "passed_with_gaps"].includes(state.verification)
    || (current.name !== "default" && (state.workspaceName !== current.name || state.workspacePath !== root))) {
    throw new Error("Exact landed delivery evidence is missing or conflicts with this workspace");
  }
  const context = await workspaceContext(cwd, state.integrationBranch);
  if (!context || context.integration.root !== state.integrationRoot) throw new Error("Integrated repository identity changed");
  const proof = await jj(cwd, ["log", "-r", `${expected} & ::${state.integrationBranch}`, "--no-graph", "-T", 'commit_id ++ "\t" ++ change_id ++ "\t" ++ conflict']);
  if (proof !== `${expected}\t${state.artifactChangeId}\tfalse`) throw new Error("Artifact is no longer integrated exactly");
  return { context, state: { ...state, phase: "landed" }, gitDirectory };
}

/** Retry delivery only, never source landing or primary checkout synchronization. */
export async function finalizeIntegratedWorkspace(cwd, options) {
  const expected = options?.expectedCommitSha;
  const evidence = await readIntegratedWorkspaceEvidence(cwd, expected);
  if (!evidence) throw new Error("Exact landed delivery evidence is missing");
  const { state, gitDirectory } = evidence;
  if (!options.inspectOnly) await archiveIntegratedWorkspaceEvidence(gitDirectory, state);
  const readIntegrationTip = () => jj(cwd, ["log", "-r", state.integrationBranch, "--no-graph", "-T", "commit_id"]);
  const postIntegration = await finalizePostIntegration({
    gitDirectory, integratedCommitSha: expected,
    approval: options.approval, inspectOnly: options.inspectOnly === true, abortSignal: options.abortSignal,
    readIntegrationTip,
  });
  if (!postIntegration.ok) {
    return {
      ok: false,
      sourceIntegrated: true,
      endpoint: "local_integration",
      integratedCommitSha: expected,
      postIntegration,
      sourcePublication: {
        ok: false,
        sourceIntegrated: true,
        status: "pending",
        integratedCommitSha: expected,
        integrationBranch: state.integrationBranch,
        reason: "Source publication waits for post-integration finalization",
      },
      reason: postIntegration.reason,
    };
  }
  const sourcePublication = await finalizeSourcePublication({
    gitDirectory,
    integratedCommitSha: expected,
    integrationBranch: state.integrationBranch,
    readIntegrationTip,
    localOnly: options.localOnly ?? state.localOnly,
    inspectOnly: options.inspectOnly === true,
    abortSignal: options.abortSignal,
  });
  return {
    ok: sourcePublication.ok,
    sourceIntegrated: true,
    endpoint: sourcePublication.status === "complete" ? "git_remote" : "local_integration",
    integratedCommitSha: expected,
    postIntegration,
    sourcePublication,
    ...(sourcePublication.reason ? { reason: sourcePublication.reason } : {}),
  };
}
