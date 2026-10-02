import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, existsSync, openSync, statSync } from "node:fs";
import { mkdir, readdir, realpath, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  artifactPublished,
  finishLandedWorkspace,
  landingStatePaths,
  listWorkspaces,
  lockPath,
  metadataPath,
  prepareWorkspaceDependencies,
  readLandingState,
  renameWorkspace,
  revisionExists,
  run,
  workspaceContext,
  workspaceHasUnintegratedWork,
  workspaceMetadata,
} from "./peach-workspace.mjs";
import { generatedPathMatchers, readExecutionPolicy } from "./execution-policy.mjs";
import { installInputFingerprint } from "./install-inputs.mjs";
import { finalizePostIntegration } from "./post-integration-finalization.mjs";
import { cleanupRetentionReason } from "./workspace-delivery-lifecycle.mjs";
import { archiveIntegratedWorkspaceEvidence } from "./workspace-finalization.mjs";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.mjs";

/**
 * One prepared, unassigned JJ workspace per Project. Assignment renames it to
 * the task's name (its directory is stable), moves it to the current integration
 * head and reconciles dependencies there. A spare holds no work, so it is freely
 * replaceable; only spares are ever created or claimed here.
 */
const WORKSPACE_HOME = join(homedir(), ".pi", "workspaces");

function projectSlug(root) {
  return basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 24) || "project";
}

async function jj(cwd, args) {
  const result = await run("jj", ["--color=never", ...args], { cwd });
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

/** Unassigned spares for this repository that no live process is preparing. */
export async function readySpares(cwd) {
  return (await listWorkspaces(cwd)).filter((workspace) =>
    workspace.metadata?.spare === true && workspace.metadata?.prepared === true && workspace.root && existsSync(workspace.root));
}

/** Prepare one spare under the allocation transaction, never a session writer lease. */
export async function provisionSpare(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context) return { provisioned: false, reason: "not-jj" };
  return withWorkspaceTransaction(`pool:${context.integration.root}`, async () => {
    const spare = (await listWorkspaces(cwd)).find((workspace) => workspace.metadata?.spare === true);
    if (spare?.metadata?.prepared === true) return { provisioned: false, reason: "spare-exists" };
    const name = spare?.name ?? `${projectSlug(context.integration.root)}-spare-${randomUUID().slice(0, 6)}`;
    const workspacePath = spare?.root ?? join(WORKSPACE_HOME, name);
    if (!spare) {
      await mkdir(WORKSPACE_HOME, { recursive: true, mode: 0o700 });
      await jj(context.integration.root, ["workspace", "add", "--name", name, "--revision", context.integrationBranch, workspacePath]);
      await mkdir(join(homedir(), ".pi", "agent", "workspace-state", "workspaces"), { recursive: true, mode: 0o700 });
      await writeWorkspaceJson(metadataPath(name), {
        version: 1, workspaceName: name, workspacePath, integrationRoot: context.integration.root,
        spare: true, prepared: false, createdAt: new Date().toISOString(),
      });
    }
    // An interrupted preparation remains unassigned and can be retried here.
    const { state, packageManager, installInputs } = await prepareWorkspaceDependencies(workspacePath, { quiet: true, recordInputs: true });
    await writeWorkspaceJson(metadataPath(name), {
      ...await workspaceMetadata(name), prepared: true, preparedDependencies: { state, packageManager, installInputs },
    });
    return { provisioned: true, workspacePath };
  });
}

/**
 * The spare's provisioned dependencies as readiness, when they are still exactly
 * what installing at its refreshed `@` would produce: recorded install inputs
 * equal the current ones and the installed tree is still on disk. Otherwise null.
 */
async function reusableDependencies(root, prepared) {
  if (!prepared?.installInputs || (prepared.state !== "ready" && prepared.state !== "not_required")) return null;
  if (prepared.state === "ready" && !existsSync(join(root, "node_modules"))) return null;
  if (await installInputFingerprint(root) !== prepared.installInputs) return null;
  return { state: prepared.state, packageManager: prepared.packageManager ?? null, installInputs: prepared.installInputs, reused: true };
}

/**
 * Exclusively assign a ready spare as workspace `name`, refreshed to the current
 * integration head. `dependencies` is the reusable readiness when the refresh
 * left the install inputs unchanged, else null and the caller installs. Returns
 * null when no spare is ready, including while one is being provisioned (which
 * holds the pool for its whole install); the caller then provisions
 * synchronously. Never falls back to the primary checkout.
 */
export async function claimSpare(cwd, name) {
  const context = await workspaceContext(cwd);
  if (!context) return null;
  return await withWorkspaceTransaction(`pool:${context.integration.root}`, () => claimReadySpare(cwd, context, name), { wait: false })
    .catch((error) => { if (error?.code === "ELOCKED") return null; throw error; });
}

async function claimReadySpare(cwd, context, name) {
  const [spare] = await readySpares(cwd);
  if (!spare) return null;
  const { name: assigned } = await renameWorkspace(spare.root, name);
  await jj(spare.root, ["new", context.integrationBranch]);
  const dependencies = await reusableDependencies(spare.root, spare.metadata?.preparedDependencies);
  const { spare: _released, prepared: _prepared, preparedDependencies: _dependencies, createdAt: _created, ...metadata } =
    (await workspaceMetadata(assigned)) ?? {};
  await writeWorkspaceJson(metadataPath(assigned), { ...metadata, workspaceName: assigned, claimedAt: new Date().toISOString() });
  return { root: spare.root, name: assigned, dependencies };
}

const REFILL_LOG_LIMIT = 1024 * 1024;
// Evaluated by the refill child: this module's own `provisionSpare`, one JSON line per outcome.
const REFILL_SCRIPT = `import(process.env.PEACH_REFILL_MODULE)
  .then((m) => m.provisionSpare(process.env.PEACH_REFILL_ROOT))
  .then((r) => console.log(new Date().toISOString(), JSON.stringify(r)),
    (e) => { console.error(new Date().toISOString(), "refill failed:", e?.stack ?? e); process.exitCode = 1; });`;

/**
 * Refill the repository's spare pool without blocking the caller: a detached,
 * `nice`d child runs `provisionSpare` for the integration root and appends its
 * outcome to `~/.pi/agent/workspace-state/pool-refill.log`. Concurrent refills
 * serialise on the pool transaction, and a ready spare makes one a no-op. While
 * a refill is in flight, a claim finds no ready spare and installs a fresh
 * workspace instead of waiting. `started` means the child process spawned; its
 * outcome is only in the log. `command` replaces the spawned argv (tests).
 */
export async function startSpareRefill(cwd = process.cwd(), options = {}) {
  const context = await workspaceContext(cwd);
  if (!context) return { started: false, reason: "not-jj" };
  const stateHome = join(homedir(), ".pi", "agent", "workspace-state");
  await mkdir(stateHome, { recursive: true, mode: 0o700 });
  const logPath = join(stateHome, "pool-refill.log");
  let oversized = false;
  try { oversized = statSync(logPath).size > REFILL_LOG_LIMIT; } catch { /* no log yet */ }
  const log = openSync(logPath, oversized ? "w" : "a", 0o600);
  try {
    const [executable, ...args] = options.command ?? ["nice", "-n", "10", process.execPath, "-e", REFILL_SCRIPT];
    const child = spawn(executable, args, {
      cwd: context.integration.root,
      detached: true,
      stdio: ["ignore", log, log],
      env: { ...process.env, PEACH_REFILL_MODULE: import.meta.url, PEACH_REFILL_ROOT: context.integration.root },
    });
    const spawned = await new Promise((resolveSpawn) => {
      child.once("spawn", () => resolveSpawn(null));
      child.once("error", (error) => resolveSpawn(error));
    });
    if (spawned) return { started: false, reason: spawned.message, logPath };
    child.unref();
    return { started: true, pid: child.pid, logPath };
  } finally {
    closeSync(log);
  }
}

const REPRODUCIBLE = new Set([
  ".jj", ".git", "node_modules", ".svelte-check", ".svelte-kit", ".wrangler", ".turbo", ".vite", ".cache",
  ".next", "dist", "build", "out", "coverage", "target", "DerivedData", ".DS_Store",
  ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".vercel", ".astro", ".swc",
]);

/**
 * The shared cleanup check for a landed checkout: material neither tracked nor
 * reproducible under the integration checkout's declared `generatedPaths`.
 * Every cleanup surface (Pi launcher, CLI, Peach host) must pass this first.
 */
export async function retainedWorkspaceMaterial(root, integrationRoot, limit = 5) {
  return uniqueUntrackedMaterial(root, limit, await declaredGeneratedPaths(integrationRoot));
}

/** One human explanation of why cleanup kept a landed workspace. */
export function describeRetention(result) {
  if (result?.reason !== "unique-files") return String(result?.reason ?? "cleanup did not complete");
  return `holds files cleanup will not delete: ${(result.paths ?? []).join(", ")}`
    + " (remove them, or declare generated output in .peach/execution.json generatedPaths)";
}

/** Cleanup judges files on disk, so it reads the primary checkout's working policy (strictly). */
async function declaredGeneratedPaths(integrationRoot) {
  return generatedPathMatchers((await readExecutionPolicy(integrationRoot))?.generatedPaths);
}

/**
 * Files in a checkout that are neither tracked nor reproducible (a built-in tool
 * cache or a path the repository declares as generated): ignored or unexplained
 * material that cleanup must not destroy. Symlinks are reported, never followed.
 * Returns at most `limit` repository-relative paths.
 */
export async function uniqueUntrackedMaterial(root, limit = 5, generated = []) {
  const tracked = new Set((await jj(root, ["file", "list"])).split("\n").filter(Boolean));
  const found = [];
  async function walk(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (found.length >= limit) return;
      if (REPRODUCIBLE.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (generated.some((matcher) => matcher.test(`${path}/`))) continue;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (!tracked.has(path)) found.push(path);
    }
  }
  await walk(root, "");
  return found;
}

/**
 * Release a delivered checkout: integrated, published, no new or unique material.
 * Serialized with landing and host writes on the workspace's `writer:` key, which
 * is not reentrant: never call this while holding that key. `hooks` lets a host
 * supply its guarded forget, lifecycle event and command environment.
 */
export async function cleanupLandedWorkspace(cwd = process.cwd(), hooks = {}) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") return { cleaned: false, reason: "not-isolated" };
  return withWorkspaceTransaction(`writer:${context.current.name}`, () => cleanupLandedWorkspaceUnlocked(cwd, hooks));
}

async function cleanupLandedWorkspaceUnlocked(cwd, hooks) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") return { cleaned: false, reason: "not-isolated" };
  const state = await readLandingState(context.current.name);
  if (!state) return { cleaned: false, reason: "not-landed" };
  if (resolve(state.workspacePath) !== resolve(context.current.root) || state.workspaceName !== context.current.name) {
    throw new Error("Landing state does not match the current workspace");
  }
  // Follow-up work on top of the landed artifact is never deleted.
  if (await workspaceHasUnintegratedWork(context.current.root, context.integrationBranch)) {
    return { cleaned: false, reason: "new-unlanded-work" };
  }
  const unique = await retainedWorkspaceMaterial(context.current.root, context.integration.root);
  if (unique.length) return { cleaned: false, reason: "unique-files", paths: unique };
  // Pending housekeeping is retried below; every other retention reason holds.
  const retention = cleanupRetentionReason({ ...state, cleanupPending: false }, context, await workspaceMetadata(context.current.name));
  if (retention) return { cleaned: false, reason: retention };
  if (!await revisionExists(context.integration.root, `${state.artifactCommitId} & ::${state.integrationBranch}`))
    throw new Error("Cannot prove the landed artifact is integrated; workspace retained");
  if (state.cleanupPending && (await finishLandedWorkspace(context, state)).cleanupPending) {
    return { cleaned: false, reason: "housekeeping-pending" };
  }
  // A pending or failed external step keeps the workspace for its land retry.
  const gitDirectory = await jj(context.integration.root, ["--ignore-working-copy", "git", "root"]);
  const external = await finalizePostIntegration({ gitDirectory, integratedCommitSha: state.artifactCommitId, inspectOnly: true,
    readIntegrationTip: () => jj(context.integration.root, ["--ignore-working-copy", "log", "--no-graph", "-r", state.integrationBranch, "-T", "commit_id"]),
    ...(hooks.environment ? { environment: hooks.environment } : {}) });
  if (!external.ok) return { cleaned: false, reason: `post-integration-${external.status}` };
  if (!await artifactPublished(cwd, context, state)) return { cleaned: false, reason: "not-published" };
  // Cleanup deletes only checkouts beneath Peach workspace storage.
  if (!await withinWorkspaceStorage(context.current.root)) return { cleaned: false, reason: "outside-workspace-storage" };
  await archiveIntegratedWorkspaceEvidence(gitDirectory, state);
  await retireWorkspace(context.integration.root, context.current, hooks);
  return { cleaned: true };
}

export async function removeWorkspace(cwd, workspaceName, options = {}) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Not inside a Jujutsu repository");
  if (workspaceName === "default")
    throw new Error("The canonical default workspace cannot be removed");
  if (workspaceName === context.current.name)
    throw new Error("Cannot remove the workspace hosting this Pi process");
  return withWorkspaceTransaction(`writer:${workspaceName}`, async () => {
    const target = (await listWorkspaces(cwd)).find((workspace) => workspace.name === workspaceName);
    if (!target?.root) throw new Error(`Unknown or unavailable JJ workspace: ${workspaceName}`);
    if (!await withinWorkspaceStorage(target.root))
      throw new Error("Refusing to remove a workspace outside ~/.pi/workspaces");
    const metadata = await workspaceMetadata(workspaceName);
    const hasWork = await workspaceHasUnintegratedWork(target.root, context.integrationBranch).catch(
      () => true,
    );
    if (hasWork && options.allowWork !== true)
      throw new Error(
        `jj:${workspaceName} contains unlanded work; explicit deletion confirmation is required`,
      );
    if (metadata?.issueNumber && options.allowIssue !== true)
      throw new Error(
        `jj:${workspaceName} is attached to Issue #${metadata.issueNumber}; explicit deletion confirmation is required`,
      );
    await retireWorkspace(context.integration.root, { name: workspaceName, root: target.root });
    return { workspaceName, hasWork, issueNumber: metadata?.issueNumber ?? null };
  });
}

/** Whether a checkout lives beneath Peach workspace storage, the only place cleanup deletes. */
export async function withinWorkspaceStorage(root) {
  const [storage, target] = await Promise.all([
    realpath(WORKSPACE_HOME).catch(() => resolve(WORKSPACE_HOME)),
    realpath(root).catch(() => resolve(root)),
  ]);
  return target.startsWith(storage + "/");
}

/** Unregister a workspace from JJ and delete its checkout, through the host's guarded forget when given. */
export async function forgetWorkspace(integrationRoot, workspaceName, workspacePath, hooks = {}) {
  if (hooks.forget) return hooks.forget(integrationRoot, workspaceName, workspacePath);
  await jj(integrationRoot, ["--ignore-working-copy", "workspace", "forget", workspaceName]);
  await rm(workspacePath, { recursive: true, force: true });
}

/**
 * The one retirement step for an isolated checkout: forget it, delete it and its
 * sidecars, then report the release. A host supplies its guarded forget and its
 * lifecycle event; the default forgets through JJ and removes the directory.
 */
export async function retireWorkspace(integrationRoot, workspace, hooks = {}) {
  const metadata = await workspaceMetadata(workspace.name);
  await forgetWorkspace(integrationRoot, workspace.name, workspace.root, hooks);
  await rm(metadataPath(workspace.name), { force: true });
  for (const path of landingStatePaths(workspace.name)) await rm(path, { force: true });
  await rm(lockPath(workspace.name), { force: true });
  const issueNumber = Number.isInteger(metadata?.issueNumber) && metadata.issueNumber > 0 ? metadata.issueNumber : null;
  hooks.onReleased?.({ workspaceName: workspace.name, projectRoot: integrationRoot, issueNumber });
}

