import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
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
    await prepareWorkspaceDependencies(workspacePath, { quiet: true });
    await writeWorkspaceJson(metadataPath(name), { ...await workspaceMetadata(name), prepared: true });
    return { provisioned: true, workspacePath };
  });
}

/**
 * Exclusively assign a ready spare as workspace `name`, refreshed to the current
 * integration head. Returns null when no spare is ready; the caller then
 * provisions synchronously. Never falls back to the primary checkout.
 */
export async function claimSpare(cwd, name) {
  const context = await workspaceContext(cwd);
  if (!context) return null;
  return await withWorkspaceTransaction(`pool:${context.integration.root}`, async () => {
    const [spare] = await readySpares(cwd);
    if (!spare) return null;
    const { name: assigned } = await renameWorkspace(spare.root, name);
    await jj(spare.root, ["new", context.integrationBranch]);
    const { spare: _released, prepared: _prepared, createdAt: _created, ...metadata } = (await workspaceMetadata(assigned)) ?? {};
    await writeWorkspaceJson(metadataPath(assigned), { ...metadata, workspaceName: assigned, claimedAt: new Date().toISOString() });
    return { root: spare.root, name: assigned };
  });
}

const REPRODUCIBLE = new Set([
  ".jj", ".git", "node_modules", ".svelte-check", ".svelte-kit", ".wrangler", ".turbo", ".vite", ".cache",
  ".next", "dist", "build", "out", "coverage", "target", "DerivedData", ".DS_Store",
  ".venv", "__pycache__", ".pytest_cache", ".ruff_cache", ".mypy_cache", ".vercel", ".astro", ".swc",
]);

/**
 * Compile a repository's `generatedPaths` declaration from `.peach/execution.json`:
 * repository-relative paths or globs (`*` within one segment, `**` across segments)
 * of generated output that cleanup may discard. A match also covers everything
 * below it. Anything that could escape or be ambiguous fails closed.
 */
export function generatedPathMatchers(declared) {
  if (declared === undefined) return [];
  if (!Array.isArray(declared)) throw new Error(".peach/execution.json generatedPaths must be an array of repository-relative paths");
  return declared.map((entry) => {
    const segments = typeof entry === "string" ? entry.split("/") : [];
    if (!segments.length || entry.startsWith("/") || entry.includes("\\") || entry.includes("\0")
      || segments.some((segment) => !segment || segment === "." || segment === ".." || (segment.includes("**") && segment !== "**"))
      || segments.every((segment) => /^\**$/.test(segment))) {
      throw new Error(`.peach/execution.json generatedPaths entry ${JSON.stringify(entry)} must be a specific repository-relative path without '.', '..', or empty segments`);
    }
    const pattern = segments.map((segment) => segment === "**" ? "(?:[^/]+/)*"
      : `${segment.split("*").map((part) => part.replace(/[.+?^${}()|[\]]/g, "\\$&")).join("[^/]*")}/`).join("");
    return new RegExp(`^${pattern}$`); // tested against `path/`
  });
}

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

async function declaredGeneratedPaths(integrationRoot) {
  let raw;
  try { raw = await readFile(join(integrationRoot, ".peach", "execution.json"), "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return []; throw error; }
  return generatedPathMatchers(JSON.parse(raw)?.generatedPaths);
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

