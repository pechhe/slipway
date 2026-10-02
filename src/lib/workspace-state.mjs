import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { LANDED_WORKSPACE_REFUSAL, workspaceContinuationDisposition } from "./workspace-delivery-lifecycle.mjs";
import { jj, parseWorkspaceList, revisionExists, revisionFacts, workspaceContext, workspaceHasUnintegratedWork, workspaceSlug } from "./workspace-jj.mjs";
import { landedHome, lockHome, metadataHome, modePath, stateHome } from "./workspace-paths.mjs";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.mjs";

/**
 * Machine-local workspace state: the checkout mode, per-workspace metadata and
 * owner records, landing-state sidecars, and the workspace list joined with them.
 */

export async function readWorkspaceMode() {
  // Resolved outside the fallback, so a pending cutover refuses instead of reading as "isolated".
  const path = modePath();
  try {
    const parsed = JSON.parse(await readFile(path, "utf8"));
    return parsed.mode === "direct" ? "direct" : "isolated";
  } catch {
    return "isolated";
  }
}

export async function writeWorkspaceMode(mode) {
  if (mode !== "isolated" && mode !== "direct")
    throw new Error("Workspace mode must be isolated or direct");
  await mkdir(dirname(modePath()), { recursive: true, mode: 0o700 });
  await writeFile(modePath(), JSON.stringify({ version: 1, mode }, null, 2), { mode: 0o600 });
  return mode;
}

export function lockPath(workspaceName) {
  return join(lockHome(), `${workspaceName}.json`);
}

export async function readJsonOptional(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export function metadataPath(workspaceName) {
  return join(metadataHome(), `${workspaceName}.json`);
}

export async function workspaceMetadata(workspaceName) {
  return await readJsonOptional(metadataPath(workspaceName));
}

/**
 * Every JJ workspace of the repository with its metadata. Metadata whose recorded
 * name or path no longer matches JJ (after a rename or move) is corrected unless
 * `readOnly`; a workspace JJ recorded without a root falls back to its metadata path.
 */
export async function listWorkspaces(cwd = process.cwd(), options = {}) {
  const context = await workspaceContext(cwd);
  if (!context) return [];
  const output = await jj(cwd, [
    "--ignore-working-copy",
    "workspace",
    "list",
    "-T",
    'name ++ "\\t" ++ root ++ "\\t" ++ target.change_id() ++ "\\t" ++ target.commit_id() ++ "\\n"',
  ]);
  return await Promise.all(
    parseWorkspaceList(output).map(async (workspace) => {
      let metadata = await workspaceMetadata(workspace.name);
      if (metadata && workspace.root && (metadata.workspaceName !== workspace.name
        || typeof metadata.workspacePath !== "string" || resolve(metadata.workspacePath) !== resolve(workspace.root))) {
        metadata = { ...metadata, workspaceName: workspace.name, workspacePath: workspace.root };
        if (!options.readOnly) {
          await mkdir(metadataHome(), { recursive: true, mode: 0o700 });
          await writeFile(metadataPath(workspace.name), JSON.stringify(metadata, null, 2), { mode: 0o600 });
        }
      }
      const metadataRoot = typeof metadata?.workspacePath === "string"
        && await stat(metadata.workspacePath).then(() => true, () => false) ? metadata.workspacePath : "";
      return { ...workspace, root: workspace.root || metadataRoot, metadata };
    }),
  );
}

export async function inspectWorkspaces(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context) return [];
  const workspaces = await listWorkspaces(cwd);
  return await Promise.all(
    workspaces.map(async (workspace) => ({
      ...workspace,
      hasWork:
        workspace.name === "default"
          ? false
          : await workspaceHasUnintegratedWork(workspace.root, context.integrationBranch).catch(() => true),
      landed: Boolean(await readLandingState(workspace.name, { readOnly: true })),
    })),
  );
}

export async function inspectWorkspace(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context) return null;
  const workspaces = await inspectWorkspaces(cwd);
  return (
    workspaces.find((workspace) => workspace.root && resolve(workspace.root) === resolve(context.current.root)) ??
    null
  );
}

export async function findWorkspace(cwd, name) {
  const workspaces = await listWorkspaces(cwd);
  const workspace = workspaces.find((entry) => entry.name === name);
  if (!workspace?.root) throw new Error(`Unknown or unavailable JJ workspace: ${name}`);
  return workspace;
}

async function moveSidecarFile(directory, oldName, newName, transform) {
  const source = join(directory, `${oldName}.json`);
  try {
    const data = JSON.parse(await readFile(source, "utf8"));
    await writeFile(join(directory, `${newName}.json`), JSON.stringify(transform(data), null, 2), {
      mode: 0o600,
    });
    await rm(source, { force: true });
  } catch {
    // No sidecar state for this workspace under this directory.
  }
}

/** Rename the current isolated workspace and keep its lock, metadata and both
 *  landing-state sidecars consistent, recording the rename history. Names are
 *  slugged; collisions get numeric suffixes. */
export async function renameWorkspace(cwd, desired) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default")
    throw new Error("Only isolated JJ workspaces can be renamed");
  const base = workspaceSlug(desired, 60);
  if (!base) throw new Error("New workspace name is empty after normalization");
  const taken = new Set((await listWorkspaces(cwd)).map((workspace) => workspace.name));
  taken.delete(context.current.name);
  let name = base;
  for (let index = 2; taken.has(name); index += 1) name = `${base}-${index}`;

  await jj(context.current.root, ["workspace", "rename", name]);
  const oldName = context.current.name;
  const operationId = await jj(context.current.root, ["op", "log", "-n", "1", "--no-graph", "-T", "self.id()"]);
  const target = await revisionFacts(context.current.root, "@");
  const renamed = (data) => ({
    ...data,
    workspaceName: name,
    previousWorkspaceNames: [...new Set([
      ...(Array.isArray(data.previousWorkspaceNames) ? data.previousWorkspaceNames.filter((value) => typeof value === "string" && value.trim()) : []),
      oldName,
    ])].slice(-16),
  });
  await moveSidecarFile(lockHome(), oldName, name, (data) => ({ ...data, workspaceName: name }));
  await moveSidecarFile(metadataHome(), oldName, name, (data) => ({
    ...renamed(data),
    workspaceRenameEpochs: [
      ...(Array.isArray(data.workspaceRenameEpochs) ? data.workspaceRenameEpochs.filter((value) => value && typeof value === "object") : []),
      { version: 1, operationId, fromName: oldName, toName: name, workspacePath: context.current.root, changeId: target.changeId, commitId: target.commitId },
    ].slice(-16),
  }));
  for (const directory of [stateHome(), landedHome()]) await moveSidecarFile(directory, oldName, name, renamed);
  return { oldName, name };
}

export async function workspaceContinuationState(context) {
  if (!context || context.current.name === "default") return { kind: "active" };
  const state = await readLandingState(context.current.name);
  const metadata = await workspaceMetadata(context.current.name);
  const issueNumber = typeof metadata?.issueNumber === "number" ? metadata.issueNumber : null;
  return workspaceContinuationDisposition(state, {
    workspaceName: context.current.name,
    workspacePath: context.current.root,
    integrationRoot: context.integration.root,
    integrationBranch: context.integrationBranch,
    issueNumber,
    hasUnintegratedWork: await workspaceHasUnintegratedWork(context.current.root, context.integrationBranch),
    landedArtifactIntegrated: Boolean(
      state?.artifactCommitId
      && await revisionExists(context.integration.root, `${state.artifactCommitId} & ::${context.integrationBranch}`),
    ),
  });
}

export async function assertWorkspaceMutationAllowed(context) {
  const continuation = await workspaceContinuationState(context);
  if (["active", "resume_unfinished"].includes(continuation.kind)) return;
  if (continuation.kind === "landed_source") throw new Error(LANDED_WORKSPACE_REFUSAL);
  throw new Error(`Historical landing evidence requires explicit recovery before mutation (${continuation.reason})`);
}

/** Refuse to associate an Issue already held by another workspace. */
export async function assertIssueAvailable(cwd, issueNumber, intendedWorkspace) {
  if (!issueNumber) return;
  for (const workspace of await listWorkspaces(cwd)) {
    if (workspace.name === intendedWorkspace || workspace.metadata?.issueNumber !== issueNumber)
      continue;
    throw new Error(
      `Issue #${issueNumber} is already associated with jj:${workspace.name}; resume that workspace instead`,
    );
  }
}

export async function attachWorkspaceIssue(cwd, issueNumber) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Issue attachment requires a native workspace");
  return withWorkspaceTransaction(`association:${context.integration.root}`, () => attachWorkspaceIssueUnlocked(cwd, issueNumber));
}

async function attachWorkspaceIssueUnlocked(cwd, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0)
    throw new Error("Issue number must be a positive integer");
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default")
    throw new Error("Attach Issues only to isolated JJ workspaces");
  await assertWorkspaceMutationAllowed(context);
  await assertIssueAvailable(cwd, issueNumber, context.current.name);
  const prior = await workspaceMetadata(context.current.name);
  if (prior?.issueNumber && prior.issueNumber !== issueNumber) throw new Error("This workspace already belongs to another Issue; preserve its identity");
  await mkdir(metadataHome(), { recursive: true, mode: 0o700 });
  const metadata = {
    ...(await workspaceMetadata(context.current.name)),
    version: 1,
    workspaceName: context.current.name,
    workspacePath: context.current.root,
    integrationRoot: context.integration.root,
    issueNumber,
    attachedAt: new Date().toISOString(),
  };
  await writeFile(metadataPath(context.current.name), JSON.stringify(metadata, null, 2), {
    mode: 0o600,
  });
  return metadata;
}

export function statePath(workspaceName) {
  return join(stateHome(), `${workspaceName}.json`);
}

/** Landing-state sidecars for a workspace: the current top-level path, then the legacy `landed/` path. */
export function landingStatePaths(workspaceName) {
  return [statePath(workspaceName), join(landedHome(), `${workspaceName}.json`)];
}

function isLandingState(value) {
  return Boolean(value && value.version === 1 && typeof value.workspaceName === "string" && typeof value.workspacePath === "string"
    && typeof value.integrationBranch === "string" && typeof value.artifactCommitId === "string");
}

/**
 * A workspace's landing record from either sidecar. A `prepared` record whose
 * artifact the integration bookmark already contains was interrupted after the
 * bookmark moved; it is promoted to `landed` (unless `readOnly`) so the next land
 * finishes housekeeping instead of verifying again. Otherwise it is not a landing.
 */
export async function readLandingState(workspaceName, options = {}) {
  for (const path of landingStatePaths(workspaceName)) {
    const state = await readJsonOptional(path);
    if (!isLandingState(state)) continue;
    if (state.phase === "prepared" && !options.readOnly) {
      if (!state.integrationRoot || !await revisionExists(state.integrationRoot, `${state.artifactCommitId} & ::${state.integrationBranch}`)) return null;
      state.phase = "landed";
      await writeWorkspaceJson(path, state);
    }
    return state;
  }
  return null;
}
