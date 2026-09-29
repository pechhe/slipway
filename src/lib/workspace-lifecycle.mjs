import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import {
  acquireWorkspaceLock,
  activeWorkspaceLock,
  artifactPublished,
  listWorkspaces,
  lockPath,
  metadataPath,
  prepareWorkspaceDependencies,
  renameWorkspace,
  revisionExists,
  run,
  statePath,
  workspaceContext,
  workspaceHasUnintegratedWork,
  workspaceMetadata,
} from "./peach-workspace.mjs";
import { cleanupRetentionReason } from "./workspace-delivery-lifecycle.mjs";
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
    workspace.metadata?.spare === true && !workspace.lock && workspace.root && existsSync(workspace.root));
}

/** Ensure one spare exists; dependency preparation happens outside the pool lock. */
export async function provisionSpare(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context) return { provisioned: false, reason: "not-jj" };
  const created = await withWorkspaceTransaction(`pool:${context.integration.root}`, async () => {
    const all = await listWorkspaces(cwd);
    if (all.some((workspace) => workspace.metadata?.spare === true)) return null;
    const name = `${projectSlug(context.integration.root)}-spare-${randomUUID().slice(0, 6)}`;
    const workspacePath = join(WORKSPACE_HOME, name);
    await mkdir(WORKSPACE_HOME, { recursive: true, mode: 0o700 });
    await jj(context.integration.root, ["workspace", "add", "--name", name, "--revision", context.integrationBranch, workspacePath]);
    await mkdir(join(homedir(), ".pi", "agent", "workspace-state", "workspaces"), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(metadataPath(name), {
      version: 1, workspaceName: name, workspacePath, integrationRoot: context.integration.root,
      spare: true, createdAt: new Date().toISOString(),
    });
    return workspacePath;
  });
  if (!created) return { provisioned: false, reason: "spare-exists" };
  // Held while installing so a concurrent claim skips it rather than racing the install.
  const spare = await workspaceContext(created);
  const release = await acquireWorkspaceLock(spare);
  try {
    await prepareWorkspaceDependencies(created, { quiet: true });
  } finally {
    await release();
  }
  return { provisioned: true, workspacePath: created };
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
    const { spare: _released, createdAt: _created, ...metadata } = (await workspaceMetadata(assigned)) ?? {};
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
 * Files in a checkout that are neither tracked nor a declared reproducible cache:
 * ignored or unexplained material that cleanup must not destroy. Symlinks are
 * reported, never followed. Returns at most `limit` repository-relative paths.
 */
export async function uniqueUntrackedMaterial(root, limit = 5) {
  const tracked = new Set((await jj(root, ["file", "list"])).split("\n").filter(Boolean));
  const found = [];
  async function walk(directory, relative) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (found.length >= limit) return;
      if (REPRODUCIBLE.has(entry.name) || entry.name.endsWith(".tsbuildinfo")) continue;
      const path = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(join(directory, entry.name), path);
      else if (!tracked.has(path)) found.push(path);
    }
  }
  await walk(root, "");
  return found;
}

/** Release a delivered checkout: integrated, published, no new or unique material, no writer. */
export async function cleanupLandedWorkspace(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") return { cleaned: false, reason: "not-isolated" };
  return withWorkspaceTransaction(`writer:${context.current.name}`, () => cleanupLandedWorkspaceUnlocked(cwd));
}

async function cleanupLandedWorkspaceUnlocked(cwd) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default")
    return { cleaned: false, reason: "not-isolated" };
  let state;
  try {
    state = JSON.parse(await readFile(statePath(context.current.name), "utf8"));
  } catch {
    return { cleaned: false, reason: "not-landed" };
  }
  if (
    resolve(state.workspacePath) !== resolve(context.current.root) ||
    state.workspaceName !== context.current.name
  ) {
    throw new Error("Landing state does not match the current workspace");
  }
  if (await workspaceHasUnintegratedWork(context.current.root, context.integrationBranch)) {
    return { cleaned: false, reason: "new-unlanded-work" };
  }
  const unique = await uniqueUntrackedMaterial(context.current.root);
  if (unique.length) return { cleaned: false, reason: "unique-files", paths: unique };
  const retention = cleanupRetentionReason(state, context, await workspaceMetadata(context.current.name));
  if (retention) return { cleaned: false, reason: retention };
  if (await activeWorkspaceLock(context.current.name)) return { cleaned: false, reason: "writer-owned" };
  const integrated = await revisionExists(
    context.integration.root,
    `${state.artifactCommitId} & ::${state.integrationBranch}`,
  );
  if (!integrated)
    throw new Error("Cannot prove the landed artifact is integrated; workspace retained");
  if (!await artifactPublished(cwd, context, state)) return { cleaned: false, reason: "not-published" };
  await jj(context.integration.root, ["--ignore-working-copy", "workspace", "forget", context.current.name]);
  await rm(context.current.root, { recursive: true, force: true });
  await rm(statePath(context.current.name), { force: true });
  await rm(metadataPath(context.current.name), { force: true });
  await rm(lockPath(context.current.name), { force: true });
  return { cleaned: true };
}

