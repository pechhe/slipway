import { readdir, readFile, readlink, stat } from "node:fs/promises";
import { platform } from "node:os";
import { join, resolve, sep } from "node:path";
import { inspectWorkspaces, lockPath, removeWorkspace, run, workspaceContext } from "./peach-workspace.mjs";
import { cleanupLandedWorkspace, retainedWorkspaceMaterial } from "./workspace-lifecycle.mjs";

/**
 * Disposable-workspace housekeeping shared by every surface that lands or
 * launches. Landed checkouts go through `cleanupLandedWorkspace`'s delivery
 * checks; a source-empty checkout is removed once `EMPTY_IDLE_MS` has passed
 * since it was assigned. Neither is touched while a live process works in it, and
 * unique untracked material always keeps a workspace. Unfinished work is never
 * swept: only `hasWork === false` checkouts qualify.
 */
export const EMPTY_IDLE_MS = 24 * 60 * 60 * 1000;

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function within(path, root) {
  const target = resolve(path);
  const base = resolve(root);
  return target === base || target.startsWith(base + sep);
}

/** Working directories of every process on this host, or null when they cannot be read. */
async function processWorkingDirectories() {
  if (platform() === "linux") {
    const cwds = [];
    for (const entry of await readdir("/proc").catch(() => [])) {
      if (!/^\d+$/.test(entry)) continue;
      const cwd = await readlink(join("/proc", entry, "cwd")).catch(() => null);
      if (cwd) cwds.push(cwd);
    }
    return cwds;
  }
  const result = await run("lsof", ["-n", "-P", "-w", "-d", "cwd", "-F", "n"]).catch(() => null);
  // lsof exits 1 when some processes could not be inspected; the rest is still valid.
  if (!result || !result.stdout) return null;
  return result.stdout.split("\n").filter((line) => line.startsWith("n/")).map((line) => line.slice(1));
}

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
  const { emptyIdleMs = EMPTY_IDLE_MS, protectedRoots = [], now = Date.now() } = options;
  const removed = [];
  const skipped = [];
  const context = await workspaceContext(cwd);
  if (!context) return { removed, skipped };
  const candidates = (await inspectWorkspaces(cwd)).filter((workspace) =>
    workspace.name !== "default" && workspace.root && !workspace.hasWork
    && !workspace.metadata?.spare && !workspace.metadata?.issueNumber);
  if (!candidates.length) return { removed, skipped };
  const cwds = await processWorkingDirectories();
  if (!cwds) return { removed, skipped: candidates.map(({ name }) => ({ name, reason: "process working directories unavailable" })) };
  const guarded = [...protectedRoots, process.cwd()];
  for (const workspace of candidates) {
    const skip = (reason) => skipped.push({ name: workspace.name, reason });
    if (guarded.some((root) => within(root, workspace.root))) continue;
    if (cwds.some((path) => within(path, workspace.root)) || await lockOwnerAlive(workspace.name)) {
      skip("in use by a live process");
      continue;
    }
    try {
      if (workspace.landed) {
        const result = await cleanupLandedWorkspace(workspace.root);
        if (result.cleaned) removed.push(workspace.name);
        else skip(result.reason ?? "retained");
        continue;
      }
      if (emptyIdleMs > 0 && now - await assignedAt(workspace) < emptyIdleMs) continue;
      const unique = await retainedWorkspaceMaterial(workspace.root, context.integration.root);
      if (unique.length) {
        skip(`holds unique files: ${unique.join(", ")}`);
        continue;
      }
      await removeWorkspace(context.integration.root, workspace.name);
      removed.push(workspace.name);
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error));
    }
  }
  return { removed, skipped };
}

/** Explicit `prune --empty`: every unused empty or delivered workspace now, with the same safety checks. */
export async function pruneEmptyWorkspaces(cwd = process.cwd()) {
  return sweepDisposableWorkspaces(cwd, { emptyIdleMs: 0 });
}
