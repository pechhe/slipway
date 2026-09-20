import { readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cleanupRetentionReason } from "./workspace-delivery-lifecycle.mjs";

async function optionalJson(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

/** Native metadata reserves source authority even when its writer is stopped.
 * Call under the existing repository association transaction when binding.
 * No second graph, execution registry, or process-liveness shortcut. */
export async function assertIssueWorkspaceBoundary(root, issueNumber, workspaceName, run, options = {}) {
  if (!issueNumber) return;
  const stateRoot = options.stateRoot ?? join(homedir(), ".pi", "agent", "workspace-state");
  const remote = await run("jj", ["git", "remote", "list"], root);
  const repository = remote.match(/(?:github\.com[:/])([^\s]+?)(?:\.git)?(?:\s|$)/)?.[1];
  if (!repository) return;
  const children = new Map();
  const descendants = async (number, visited = new Set()) => {
    if (visited.has(number)) throw new Error("Cyclic GitHub hierarchy; reconcile it before acquiring source authority");
    visited.add(number);
    if (!children.has(number)) {
      const pages = JSON.parse(await run("gh", ["api", `repos/${repository}/issues/${number}/sub_issues?per_page=100`, "--paginate", "--slurp"], root));
      children.set(number, pages.flat().map((issue) => issue.number));
    }
    const result = new Set(children.get(number));
    for (const child of children.get(number)) {
      for (const descendant of await descendants(child, new Set(visited))) result.add(descendant);
    }
    return result;
  };
  const requestedChildren = await descendants(issueNumber);
  if (requestedChildren.size && !options.existingBinding) {
    throw new Error(`Epic #${issueNumber} has child delivery units; select a child instead of acquiring overlapping parent authority`);
  }
  const files = await readdir(join(stateRoot, "workspaces")).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  for (const file of files.filter((name) => name.endsWith(".json"))) {
    const metadata = await optionalJson(join(stateRoot, "workspaces", file));
    if (!metadata || metadata.workspaceName === workspaceName || !metadata.issueNumber
      || typeof metadata.integrationRoot !== "string" || resolve(metadata.integrationRoot) !== resolve(root)) continue;
    if (await reconciledWorkspace(metadata, stateRoot, root, run)) continue;
    const related = metadata.issueNumber === issueNumber || requestedChildren.has(metadata.issueNumber)
      || (await descendants(metadata.issueNumber)).has(issueNumber);
    if (!related) continue;
    throw new Error(`Issue #${issueNumber} overlaps preserved workspace jj:${metadata.workspaceName} for #${metadata.issueNumber}; reconcile that workspace through governed delivery/recovery before acquiring source authority. Its work has been preserved.`);
  }
}

async function reconciledWorkspace(metadata, stateRoot, root, run) {
  const name = metadata.workspaceName;
  const state = await optionalJson(join(stateRoot, name + ".json"))
    ?? await optionalJson(join(stateRoot, "landed", name + ".json"));
  if (!state || state.verification !== "passed" || typeof state.integrationBranch !== "string") return false;
  const context = { current: { name, root: metadata.workspacePath }, integration: { root }, integrationBranch: state.integrationBranch };
  if (cleanupRetentionReason(state, context, metadata, Infinity)) return false;
  // A retained writer or incomplete retirement still owns the old boundary.
  if (await optionalJson(join(stateRoot, "locks", name + ".json"))) return false;
  const proof = await run("jj", ["log", "--no-graph", "-r", `${state.artifactCommitId} & ::${state.integrationBranch}`, "-T", "commit_id"], root);
  if (proof.trim() !== state.artifactCommitId) return false;
  const remaining = await run("jj", ["log", "--no-graph", "-r", `(${state.integrationBranch}..@) & ~empty()`, "-T", "commit_id"], metadata.workspacePath);
  return !remaining.trim();
}

/** Reacquisition also covers workspaces bound before the hierarchy changed. */
export async function assertWorkspaceIssueBoundary(workspaceName, run) {
  const metadata = await optionalJson(join(homedir(), ".pi", "agent", "workspace-state", "workspaces", workspaceName + ".json"));
  if (!metadata?.issueNumber) return;
  if (typeof metadata.integrationRoot !== "string") throw new Error("Workspace repository identity is missing; use governed recovery");
  await assertIssueWorkspaceBoundary(metadata.integrationRoot, metadata.issueNumber, workspaceName, run, { existingBinding: true });
}
