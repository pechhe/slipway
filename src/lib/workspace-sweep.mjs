import { readFile, stat } from "node:fs/promises";
import { issueState, workspaceContext } from "./workspace-jj.mjs";
import { inspectWorkspaces, lockPath } from "./workspace-state.mjs";
import { cleanupLandedWorkspace, describeRetention, removeWorkspace, retainedWorkspaceMaterial } from "./workspace-lifecycle.mjs";
import { describeHolders, processAlive, processWorkingDirectories, within, workspaceHolders } from "./workspace-holders.mjs";
import { pruneWorkspaceState } from "./workspace-state-prune.mjs";

/**
 * Disposable-workspace housekeeping shared by every surface that lands or
 * launches. Landed checkouts go through `cleanupLandedWorkspace`'s delivery
 * checks; a source-empty checkout is removed once `EMPTY_IDLE_MS` has passed
 * since it was assigned. Neither is touched while a live process works in it, and
 * unique untracked material always keeps a workspace. Unfinished work is never
 * swept: only `hasWork === false` checkouts qualify. An Issue's checkout is
 * swept once it has landed, or while empty once `gh` reports its Issue CLOSED
 * (never while the Issue is open or its state is unknown). The sweep also prunes
 * machine-local state left by workspaces that no longer exist.
 */
export const EMPTY_IDLE_MS = 24 * 60 * 60 * 1000;

async function lockOwnerAlive(workspaceName) {
  try {
    return processAlive(JSON.parse(await readFile(lockPath(workspaceName), "utf8"))?.pid);
  } catch {
    return false;
  }
}

/**
 * When the checkout was last created, assigned or given a task. Any JJ command,
 * including this sweep's own inspection, refreshes `.jj/working_copy`, so that
 * is no measure of idleness; a source-empty checkout's age since assignment is.
 */
async function assignedAt(workspace) {
  const metadata = workspace.metadata ?? {};
  const created = await stat(workspace.root).then((info) => info.birthtimeMs || info.mtimeMs, () => 0);
  return Math.max(created, ...[metadata.updatedAt, metadata.claimedAt, metadata.createdAt].map((value) => Date.parse(value ?? "") || 0));
}

/**
 * Remove disposable workspaces in the repository containing `cwd`.
 * `emptyIdleMs` is the minimum time since assignment before an empty checkout
 * is removed (0 for an explicit prune). `protectedRoots` and
 * this process's own cwd are never removed. Fails closed: if process working
 * directories cannot be read, nothing is removed.
 */
export async function sweepDisposableWorkspaces(cwd = process.cwd(), options = {}) {
  const { emptyIdleMs = EMPTY_IDLE_MS, protectedRoots = [], now = Date.now(), issueState: readIssueState = issueState } = options;
  const removed = [];
  const skipped = [];
  const context = await workspaceContext(cwd);
  if (!context) return { removed, skipped, pruned: [] };
  const result = await sweepCandidates(context, { emptyIdleMs, protectedRoots, now, readIssueState, removed, skipped });
  return { ...result, pruned: options.pruneState === false ? [] : await pruneWorkspaceState() };
}

async function sweepCandidates(context, { emptyIdleMs, protectedRoots, now, readIssueState, removed, skipped }) {
  const result = { removed, skipped };
  const candidates = (await inspectWorkspaces(context.integration.root)).filter((workspace) =>
    workspace.name !== "default" && workspace.root && !workspace.hasWork && !workspace.metadata?.spare);
  if (!candidates.length) return result;
  const processes = await processWorkingDirectories();
  if (!processes) {
    skipped.push(...candidates.filter((workspace) => workspace.landed || !workspace.metadata?.issueNumber)
      .map(({ name, landed }) => ({ name, landed, reason: "process working directories unavailable" })));
    return result;
  }
  const guarded = [...protectedRoots, process.cwd()];
  const issueStates = new Map();
  const closed = async (issueNumber) => {
    if (!issueStates.has(issueNumber)) issueStates.set(issueNumber, await Promise.resolve(readIssueState(context.integration.root, issueNumber)).catch(() => null));
    return issueStates.get(issueNumber) === "CLOSED";
  };
  for (const workspace of candidates) {
    const skip = (reason) => skipped.push({ name: workspace.name, landed: workspace.landed, reason });
    // An Issue's checkout that has not landed qualifies only when its Issue is closed (it is empty, and
    // a closed Issue needs no idle wait); a live process or owner still protects it below.
    const issueBound = !workspace.landed && Boolean(workspace.metadata?.issueNumber);
    if (guarded.some((root) => within(root, workspace.root))) continue;
    if (issueBound && !await closed(workspace.metadata.issueNumber)) continue;
    const holders = await workspaceHolders(workspace.root, { processes });
    if (holders.length || await lockOwnerAlive(workspace.name)) {
      skip(holders.length ? `in use by a live process: ${describeHolders(holders)}` : "in use by a live process");
      continue;
    }
    try {
      if (workspace.landed) {
        const cleaned = await cleanupLandedWorkspace(workspace.root);
        if (cleaned.cleaned) removed.push(workspace.name);
        else skip(describeRetention(cleaned));
        continue;
      }
      if (!issueBound && emptyIdleMs > 0 && now - await assignedAt(workspace) < emptyIdleMs) continue;
      const unique = await retainedWorkspaceMaterial(workspace.root, context.integration.root);
      if (unique.length) {
        skip(`holds unique files: ${unique.join(", ")}`);
        continue;
      }
      await removeWorkspace(context.integration.root, workspace.name, issueBound ? { allowIssue: true } : {});
      removed.push(workspace.name);
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error));
    }
  }
  return result;
}

/** Explicit `prune --empty`: every unused empty or delivered workspace now, with the same safety checks. */
export async function pruneEmptyWorkspaces(cwd = process.cwd()) {
  return sweepDisposableWorkspaces(cwd, { emptyIdleMs: 0 });
}
