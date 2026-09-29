import { declaredPublicationRemote } from "./source-publication-policy.mjs";
import { cleanupEligibleAt, workspaceContinuationDisposition } from "./workspace-delivery-lifecycle.mjs";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.mjs";
import { summarizeVerificationFailure } from "./verification-failure.mjs";
import { verificationSlotEnvironment, withVerificationSlot } from "./verification-slot.mjs";
import { takeOverWorkspaceWriter, workspaceCurrentWriterRefusal, workspaceLandingWriterRefusal, workspaceWriterRecordMustBePreserved } from "./workspace-writer-lock.mjs";
import { assertNoForeignPrimaryWriter } from "./primary-checkout-writer.mjs";
import { assertIssueWorkspaceBoundary, assertWorkspaceIssueBoundary } from "./issue-workspace-boundary.mjs";
import { assertIssueEligible, selectImplementationIssue } from "./issue-eligibility.mjs";
import { claimSpare } from "./workspace-lifecycle.mjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { finalizePostIntegration } from "./post-integration-finalization.mjs";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { classifyCapabilityProbe, normalizeDeclaredVerification, normalizeVerificationDeclaration, verificationEvidence, verificationGap } from "./verification-policy.mjs";

const WORKSPACE_HOME = join(homedir(), ".pi", "workspaces");
const STATE_HOME = join(homedir(), ".pi", "agent", "workspace-state");
const MODE_PATH = join(homedir(), ".pi", "agent", "workspace-mode.json");
const LOCK_HOME = join(STATE_HOME, "locks");
const METADATA_HOME = join(STATE_HOME, "workspaces");

export class CommandError extends Error {
  constructor(message, result) {
    super(message);
    this.result = result;
  }
}

export function explicitIssueNumber(value) {
  if (typeof value !== "string") return null;
  const match =
    value.match(
      /\b(?:implement|work on|fix|address|take on|continue(?: with)?|start)\b[\s\S]{0,80}?(?:github\s+)?issue\s*#?\s*(\d+)\b/i,
    ) ??
    value.match(
      /\b(?:implement|work on|fix|address|take on|continue(?: with)?|start)\b[\s\S]{0,40}?#(\d+)\b/i,
    );
  return match ? Number(match[1]) : null;
}

export function taskWorkspaceName(project, issueNumber) {
  return issueNumber
    ? `${project}-i${issueNumber}`
    : `${project}-t-${randomUUID().slice(0, 6).toLowerCase()}`;
}

export async function readWorkspaceMode() {
  try {
    const parsed = JSON.parse(await readFile(MODE_PATH, "utf8"));
    return parsed.mode === "direct" ? "direct" : "isolated";
  } catch {
    return "isolated";
  }
}

export async function writeWorkspaceMode(mode) {
  if (mode !== "isolated" && mode !== "direct")
    throw new Error("Workspace mode must be isolated or direct");
  await mkdir(join(homedir(), ".pi", "agent"), { recursive: true, mode: 0o700 });
  await writeFile(MODE_PATH, JSON.stringify({ version: 1, mode }, null, 2), { mode: 0o600 });
  return mode;
}

export function lockPath(workspaceName) {
  return join(LOCK_HOME, `${workspaceName}.json`);
}

async function readJsonOptional(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return null;
  }
}

export async function activeWorkspaceLock(workspaceName) {
  const path = lockPath(workspaceName);
  const lock = await readJsonOptional(path);
  if (!lock) return null;
  if (workspaceWriterRecordMustBePreserved(lock)) return lock;
  await rm(path, { force: true });
  return null;
}

/** `takeOver` is the human's explicit authorisation (for example `--take-over`):
 * the shared governed takeover moves writer ownership to this process first. */
export async function acquireWorkspaceLock(context, options = {}) {
  if (!context || context.current.name === "default") return async () => {};
  if (options.takeOver) {
    await assertWorkspaceMutationAllowed(context);
    await assertWorkspaceIssueBoundary(context.current.name, runIssueBoundary);
    await takeOverWorkspaceWriter({
      workspaceName: context.current.name, workspacePath: context.current.root, owner: { surface: "pi", pid: process.pid },
      authorisation: { humanAuthorised: true, reason: typeof options.takeOver === "string" ? options.takeOver : "pi --take-over" },
    });
  }
  return withWorkspaceTransaction(`writer:${context.current.name}`, () => acquireWorkspaceLockUnlocked(context));
}

async function acquireWorkspaceLockUnlocked(context) {
  if (!context || context.current.name === "default") return async () => {};
  await assertWorkspaceMutationAllowed(context);
  await assertWorkspaceIssueBoundary(context.current.name, runIssueBoundary);
  await mkdir(LOCK_HOME, { recursive: true, mode: 0o700 });
  const path = lockPath(context.current.name);
  const releaseOwn = () => {
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      const current = await readJsonOptional(path);
      if (current?.pid === process.pid) await rm(path, { force: true });
    };
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const active = await activeWorkspaceLock(context.current.name);
    // This process already owns the writer (for example after a takeover).
    if (active && !workspaceLandingWriterRefusal(active, [process.pid])) return releaseOwn();
    if (active) {
      const issueNumber = (await workspaceMetadata(context.current.name))?.issueNumber ?? null;
      throw new Error(workspaceCurrentWriterRefusal({ workspaceName: context.current.name, issueNumber, lock: active }));
    }
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.writeFile(
        JSON.stringify(
          {
            version: 1,
            pid: process.pid,
            workspaceName: context.current.name,
            workspacePath: context.current.root,
            acquiredAt: new Date().toISOString(),
          },
          null,
          2,
        ),
      );
      await handle.close();
      return releaseOwn();
    } catch (error) {
      if (error?.code !== "EEXIST" || attempt > 0) throw error;
    }
  }
  throw new Error(`Could not acquire jj:${context.current.name}`);
}

export async function run(command, args, options = {}) {
  return await new Promise((resolveRun, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: options.inherit ? "inherit" : ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveRun({ code: code ?? 1, signal, stdout, stderr }));
  });
}

async function checked(command, args, options = {}) {
  const result = await run(command, args, options);
  if (result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new CommandError(
      `${command} ${args.slice(0, 3).join(" ")} failed${detail ? `: ${detail}` : ""}`,
      result,
    );
  }
  return result.stdout.trim();
}

async function jj(cwd, args, options = {}) {
  return await checked("jj", ["--color=never", ...args], { cwd, ...options });
}

function unquoteWorkspaceName(value) {
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      // Keep the raw symbol if JJ emitted a non-JSON quoted value.
    }
  }
  return value;
}

export function parseWorkspaceList(output) {
  const entries = [];
  for (const line of output.split("\n").filter(Boolean)) {
    const [rawName, root = "", changeId, commitId] = line.split("\t");
    // Older JJ workspaces may have no root; rows without identity/target data
    // are not actionable and should not disable the whole extension.
    if (!rawName || !changeId || !commitId) continue;
    entries.push({ name: unquoteWorkspaceName(rawName), root, changeId, commitId });
  }
  return entries;
}

export async function workspaceContext(cwd = process.cwd(), integratedBranch) {
  let currentRoot;
  try {
    currentRoot = await jj(cwd, ["--ignore-working-copy", "workspace", "root"]);
  } catch {
    return null;
  }
  const output = await jj(cwd, [
    "--ignore-working-copy",
    "workspace",
    "list",
    "-T",
    'name ++ "\\t" ++ root ++ "\\t" ++ target.change_id() ++ "\\t" ++ target.commit_id() ++ "\\n"',
  ]);
  const workspaces = parseWorkspaceList(output);
  // resolve("") means this process cwd, not an unavailable JJ checkout.
  const current = workspaces.find((entry) => entry.root && resolve(entry.root) === resolve(currentRoot));
  if (!current) throw new Error("Current jj workspace is not registered");
  const integration = workspaces.find((entry) => entry.name === "default");
  if (!integration?.root) throw new Error("The canonical jj workspace named 'default' is missing or unavailable");
  const configuration = integratedBranch ? { integrationBranch: integratedBranch, requiredLocalVerification: [] } : await readConfiguration(integration.root);
  const integrationBranch = configuration.integrationBranch ?? (await inferIntegrationBranch(cwd));
  if (!(await revisionExists(cwd, integrationBranch))) {
    throw new Error(
      `Configured integration bookmark '${integrationBranch}' does not exist locally`,
    );
  }
  return { current, integration, integrationBranch, configuration };
}

async function readConfiguration(root) {
  let raw;
  try { raw = await readFile(join(root, ".peach", "execution.json"), "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return { requiredLocalVerification: [] }; throw error; }
  const parsed = JSON.parse(raw);
  const remote = declaredPublicationRemote(parsed);
  const checks = parsed?.requiredLocalVerification ?? [];
  if (!parsed || typeof parsed !== "object" || !Array.isArray(checks)) throw new Error("Malformed required local verification policy");
  const requiredLocalVerification = normalizeDeclaredVerification(checks);
  if (requiredLocalVerification.length !== checks.length) throw new Error("Malformed requiredLocalVerification entry");
  return { integrationBranch: typeof parsed.integrationBranch === "string" ? parsed.integrationBranch : undefined, requiredLocalVerification, remote };
}

export async function revisionExists(cwd, revision) {
  const result = await run(
    "jj",
    ["--color=never", "--ignore-working-copy", "log", "-r", revision, "--no-graph", "-T", '"ok"'],
    { cwd },
  );
  return result.code === 0 && result.stdout.includes("ok");
}

async function inferIntegrationBranch(cwd) {
  for (const candidate of ["main", "master"]) {
    if (await revisionExists(cwd, candidate)) return candidate;
  }
  throw new Error("Could not resolve an integration bookmark (tried main/master)");
}

function slug(value, limit = 40) {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, limit) || "task"
  );
}

export function metadataPath(workspaceName) {
  return join(METADATA_HOME, `${workspaceName}.json`);
}

export async function workspaceMetadata(workspaceName) {
  return await readJsonOptional(metadataPath(workspaceName));
}

async function writeWorkspaceTaskMetadata(context, task) {
  const normalized = task.trim().slice(0, 500);
  if (!normalized || context.current.name === "default") return;
  await mkdir(METADATA_HOME, { recursive: true, mode: 0o700 });
  const existing = await workspaceMetadata(context.current.name);
  await writeFile(
    metadataPath(context.current.name),
    JSON.stringify(
      {
        ...existing,
        version: 1,
        workspaceName: context.current.name,
        workspacePath: context.current.root,
        integrationRoot: context.integration.root,
        implementationChangeId: existing?.implementationChangeId ?? context.current.changeId,
        workspaceCreationOperationId: existing?.workspaceCreationOperationId ?? await jj(context.current.root, ["op", "log", "--no-graph", "-n", "1", "-T", "id"]),
        task: normalized,
        updatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    { mode: 0o600 },
  );
}

export async function listWorkspaces(cwd = process.cwd()) {
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
    parseWorkspaceList(output).map(async (workspace) => ({
      ...workspace,
      metadata: await workspaceMetadata(workspace.name),
      lock: await activeWorkspaceLock(workspace.name),
    })),
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
          : workspace.lock
            ? true
            : await workspaceHasUnintegratedWork(workspace.root, context.integrationBranch).catch(
                () => true,
              ),
      landed: Boolean(await readJsonOptional(statePath(workspace.name))),
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

export async function removeWorkspace(cwd, workspaceName, options = {}) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Not inside a Jujutsu repository");
  if (workspaceName === "default")
    throw new Error("The canonical default workspace cannot be removed");
  if (workspaceName === context.current.name)
    throw new Error("Cannot remove the workspace hosting this Pi process");
  const target = (await listWorkspaces(cwd)).find((workspace) => workspace.name === workspaceName);
  if (!target?.root) throw new Error(`Unknown or unavailable JJ workspace: ${workspaceName}`);
  const workspaceRoot = resolve(target.root);
  const storageRoot = resolve(WORKSPACE_HOME) + "/";
  if (!workspaceRoot.startsWith(storageRoot))
    throw new Error("Refusing to remove a workspace outside ~/.pi/workspaces");
  const active = await activeWorkspaceLock(workspaceName);
  if (active)
    throw new Error(`jj:${workspaceName} is active (pid ${active.pid}); stop it before cleanup`);
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
  await jj(context.integration.root, ["--ignore-working-copy", "workspace", "forget", workspaceName]);
  await rm(workspaceRoot, { recursive: true, force: true });
  await rm(metadataPath(workspaceName), { force: true });
  await rm(statePath(workspaceName), { force: true });
  await rm(lockPath(workspaceName), { force: true });
  return { workspaceName, hasWork, issueNumber: metadata?.issueNumber ?? null };
}

export async function pruneEmptyWorkspaces(cwd = process.cwd()) {
  const removed = [];
  const skipped = [];
  for (const workspace of await inspectWorkspaces(cwd)) {
    if (
      workspace.name === "default" ||
      workspace.hasWork ||
      workspace.metadata?.issueNumber ||
      workspace.metadata?.spare ||
      workspace.lock
    )
      continue;
    try {
      await removeWorkspace(cwd, workspace.name);
      removed.push(workspace.name);
    } catch (error) {
      skipped.push({
        name: workspace.name,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { removed, skipped };
}

export async function findWorkspace(cwd, name) {
  const workspaces = await listWorkspaces(cwd);
  const workspace = workspaces.find((entry) => entry.name === name);
  if (!workspace?.root) throw new Error(`Unknown or unavailable JJ workspace: ${name}`);
  return workspace;
}

export async function findIssueWorkspace(cwd, issueNumber) {
  const matches = (await listWorkspaces(cwd)).filter(
    (entry) => entry.metadata?.issueNumber === issueNumber,
  );
  if (matches.length > 1)
    throw new Error(
      `Issue #${issueNumber} is associated with multiple JJ workspaces; reconcile them explicitly`,
    );
  return matches[0] ?? null;
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

/** Rename the current isolated workspace and keep lock/metadata/landing
 *  sidecars consistent. Names are slugged; collisions get numeric suffixes. */
export async function renameWorkspace(cwd, desired) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default")
    throw new Error("Only isolated JJ workspaces can be renamed");
  const base = slug(desired, 60);
  if (!base) throw new Error("New workspace name is empty after normalization");
  const taken = new Set((await listWorkspaces(cwd)).map((workspace) => workspace.name));
  taken.delete(context.current.name);
  let name = base;
  for (let index = 2; taken.has(name); index += 1) name = `${base}-${index}`;

  await jj(context.current.root, ["workspace", "rename", name]);
  const oldName = context.current.name;
  await moveSidecarFile(LOCK_HOME, oldName, name, (data) => ({ ...data, workspaceName: name }));
  await moveSidecarFile(METADATA_HOME, oldName, name, (data) => ({ ...data, workspaceName: name }));
  await moveSidecarFile(STATE_HOME, oldName, name, (data) => ({ ...data, workspaceName: name }));
  return { oldName, name };
}

export async function issueTitle(repositoryRoot, issueNumber) {
  const result = await run(
    "gh",
    ["issue", "view", String(issueNumber), "--json", "title", "-q", ".title"],
    {
      cwd: repositoryRoot,
    },
  );
  if (result.code !== 0) return null;
  return result.stdout.trim() || null;
}

/** Stable short project prefix used in workspace names, e.g. "yardsmith". */
export async function projectPrefix(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context) return null;
  return slug(basename(context.integration.root), 24);
}

export async function workspaceHasUnintegratedWork(workspaceRoot, integrationBranch) {
  const output = await jj(workspaceRoot, [
    "log",
    "-r",
    `(${integrationBranch}..@) & ~empty()`,
    "--no-graph",
    "-T",
    'commit_id.short() ++ "\\n"',
  ]);
  return Boolean(output.trim());
}

async function landingStateForContinuation(workspaceName) {
  return await readJsonOptional(statePath(workspaceName))
    ?? await readJsonOptional(join(STATE_HOME, "landed", `${workspaceName}.json`));
}

export async function workspaceContinuationState(context) {
  if (!context || context.current.name === "default") return { kind: "active" };
  const state = await landingStateForContinuation(context.current.name);
  const metadata = await workspaceMetadata(context.current.name);
  const issueNumber = typeof metadata?.issueNumber === "number" ? metadata.issueNumber : null;
  return workspaceContinuationDisposition(state, {
    workspaceName: context.current.name,
    workspacePath: context.current.root,
    integrationRoot: context.integration.root,
    integrationBranch: context.integrationBranch,
    issueNumber,
    reopenedArtifactCommitId: metadata?.reopenedFromArtifactCommitId ?? null,
    hasUnintegratedWork: await workspaceHasUnintegratedWork(context.current.root, context.integrationBranch),
    landedArtifactIntegrated: Boolean(
      state?.artifactCommitId
      && await revisionExists(context.integration.root, `${state.artifactCommitId} & ::${context.integrationBranch}`),
    ),
  });
}

export async function assertWorkspaceMutationAllowed(context) {
  const continuation = await workspaceContinuationState(context);
  if (["active", "resume_unfinished", "reopened"].includes(continuation.kind)) return;
  if (continuation.kind === "landed_source") {
    throw new Error("This workspace source is already landed; make the follow-up change here and land again.");
  }
  throw new Error(`Historical landing evidence requires explicit recovery before mutation (${continuation.reason})`);
}

async function assertIssueAvailable(cwd, issueNumber, intendedWorkspace) {
  if (!issueNumber) return;
  for (const workspace of await listWorkspaces(cwd)) {
    if (workspace.name === intendedWorkspace || workspace.metadata?.issueNumber !== issueNumber)
      continue;
    const owner = workspace.lock ? ` by process ${workspace.lock.pid}` : "";
    throw new Error(
      `Issue #${issueNumber} already belongs to jj:${workspace.name}${owner}; resume that workspace instead`,
    );
  }
}

async function runIssueBoundary(executable, args, cwd) {
  const result = await run(executable, args, { cwd });
  if (result.code !== 0) throw new Error(result.stderr || "Issue hierarchy unavailable");
  return result.stdout;
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
  await assertIssueWorkspaceBoundary(context.integration.root, issueNumber, context.current.name, runIssueBoundary, { existingBinding: prior?.issueNumber === issueNumber });
  await mkdir(METADATA_HOME, { recursive: true, mode: 0o700 });
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

/** Package-manager installation is the standalone Pi readiness authority. It is
 *  intentionally workspace-local and lockfile-frozen: package managers may reuse
 *  their immutable caches, but JJ workspaces never share mutable node_modules. */
async function workspaceDependencyCommand(workspacePath) {
  const raw = await readFile(join(workspacePath, "package.json"), "utf8").catch(() => null);
  if (!raw) return null;
  const packageManager = JSON.parse(raw).packageManager;
  if (typeof packageManager !== "string") {
    throw new Error(`Workspace dependency provisioning requires a declared packageManager in ${workspacePath}.`);
  }
  if (packageManager === "bun" || packageManager.startsWith("bun@")) {
    return {
      command: "bun",
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--backend=clonefile"],
    };
  }
  if (packageManager === "pnpm" || packageManager.startsWith("pnpm@")) {
    return {
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--package-import-method=clone"],
    };
  }
  if (packageManager === "npm" || packageManager.startsWith("npm@")) {
    return { command: "npm", args: ["ci", "--prefer-offline"] };
  }
  throw new Error(`Workspace dependency provisioning does not support package manager '${packageManager}'.`);
}

export async function prepareWorkspaceDependencies(workspacePath, options = {}) {
  const dependencyCommand = await workspaceDependencyCommand(workspacePath);
  if (!dependencyCommand) return { state: "not_required", packageManager: null };
  if (!options.quiet) console.log(`[deps] ${dependencyCommand.command} install in ${basename(workspacePath)}...`);
  const result = await run(dependencyCommand.command, dependencyCommand.args, { cwd: workspacePath, inherit: !options.quiet });
  if (result.code !== 0) {
    throw new Error(
      `Dependency installation failed in ${workspacePath}; fix it before starting Pi here.`,
    );
  }
  return { state: "ready", packageManager: dependencyCommand.command };
}

export async function createWorkspace(task, cwd = process.cwd(), options = {}) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Workspace isolation requires a Jujutsu repository");
  return withWorkspaceTransaction(`allocate:${context.integration.root}`, async () => {
    await assertIssueEligible(context.integration.root, options.issueNumber, context.integrationBranch, async (executable, args, root) => {
      const result = await run(executable, args, { cwd: root });
      if (result.code !== 0) throw new Error(result.stderr || "Issue eligibility unavailable");
      return result.stdout;
    });
    if (options.issueNumber) {
      const existing = await findIssueWorkspace(cwd, options.issueNumber);
      await assertIssueWorkspaceBoundary(context.integration.root, options.issueNumber, existing?.name ?? context.current.name, runIssueBoundary, { existingBinding: Boolean(existing) });
      if (existing?.root) {
        const resumed = await workspaceContext(existing.root);
        if (!resumed) throw new Error(`Issue #${options.issueNumber} workspace disappeared during resume`);
        const readiness = await prepareWorkspaceDependencies(existing.root);
        return { ...resumed, created: false, reused: true, workspacePath: existing.root, readiness };
      }
    }
    return createWorkspaceUnlocked(task, cwd, options);
  });
}

async function createWorkspaceUnlocked(task, cwd, options) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Workspace isolation requires a Jujutsu repository");
  if (context.current.name !== "default") {
    await assertWorkspaceMutationAllowed(context);
    await writeWorkspaceTaskMetadata(context, task);
    if (options.issueNumber) await attachWorkspaceIssue(context.current.root, options.issueNumber);
    const readiness = await prepareWorkspaceDependencies(context.current.root);
    return { ...context, created: false, workspacePath: context.current.root, readiness };
  }
  const project = slug(basename(context.integration.root), 24);
  const name = taskWorkspaceName(project, options.issueNumber);
  await assertIssueAvailable(cwd, options.issueNumber, name);
  // A prepared spare is the fast path; otherwise provision synchronously. Never the primary.
  const claimed = await claimSpare(cwd, name);
  const workspacePath = claimed?.root ?? join(WORKSPACE_HOME, name);
  if (!claimed) {
    await mkdir(WORKSPACE_HOME, { recursive: true, mode: 0o700 });
    await jj(cwd, ["workspace", "add", "--name", name, "--revision", context.integrationBranch, workspacePath]);
  }
  const created = await workspaceContext(workspacePath);
  if (!created || created.current.name !== (claimed?.name ?? name))
    throw new Error("Created workspace could not be verified");
  await writeWorkspaceTaskMetadata(created, task);
  if (options.issueNumber) await attachWorkspaceIssue(workspacePath, options.issueNumber);
  const readiness = await prepareWorkspaceDependencies(workspacePath);
  return { ...created, created: true, reused: false, pooled: Boolean(claimed), workspacePath, readiness };
}

async function revisionFacts(cwd, revision) {
  const output = await jj(cwd, ["log", "-r", revision, "--no-graph", "-T",
    'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ empty ++ "\\t" ++ conflict ++ "\\t" ++ description.first_line() ++ "\\n"']);
  const [changeId, commitId, empty, conflict, description = ""] = output.split("\t");
  return {
    changeId,
    commitId,
    empty: empty === "true",
    conflict: conflict === "true",
    description,
  };
}

async function assertDefaultReady(context) {
  await assertNoForeignPrimaryWriter(context.integration.root);
  const facts = await revisionFacts(context.integration.root, "@");
  if (facts.conflict)
    throw new Error("Canonical checkout has conflicts; preserving both workspaces");
  if (!facts.empty)
    throw new Error(
      "Canonical checkout has unintegrated changes; preserve or reconcile them before landing",
    );
  return facts;
}

export function statePath(workspaceName) {
  return join(STATE_HOME, `${workspaceName}.json`);
}

async function writeLandingState(context, artifact, verification, phase = "landed", localOnly) {
  await mkdir(STATE_HOME, { recursive: true, mode: 0o700 });
  await writeWorkspaceJson(statePath(context.current.name), {
    version: 1, phase, ...(localOnly !== undefined ? { localOnly } : {}), workspaceName: context.current.name, workspacePath: context.current.root,
    integrationRoot: context.integration.root, integrationBranch: context.integrationBranch,
    artifactCommitId: artifact.commitId, artifactChangeId: artifact.changeId,
    artifactDescription: artifact.description, verification: verification.status,
    verificationCommands: verification.passed, verificationEvidence: verification, landedAt: new Date().toISOString(),
    workspaceImplementationChangeId: (await workspaceMetadata(context.current.name))?.implementationChangeId,
    cleanupEligibleAt: cleanupEligibleAt(new Date().toISOString()),
    ...(typeof (await workspaceMetadata(context.current.name))?.issueNumber === "number"
      ? { issueNumber: (await workspaceMetadata(context.current.name)).issueNumber } : {}),
  });
}

export async function landingPreview(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Not inside a Jujutsu repository");
  if (context.current.name === "default")
    throw new Error("Landing requires an isolated jj workspace");
  const current = await revisionFacts(cwd, "@");
  const targetRevision = current.empty ? "@-" : "@";
  const target = await revisionFacts(cwd, targetRevision);
  if (target.conflict) throw new Error("The landing artifact has conflicts");
  const stat = await jj(cwd, ["diff", "--from", context.integrationBranch, "--to", targetRevision, "--stat"]);
  return { context, targetRevision, target, stat };
}

async function assertStackConflictFree(cwd, branch, changeId) {
  const conflicts = await jj(cwd, [
    "log",
    "-r",
    `conflicts() & (${branch}..${changeId})`,
    "--no-graph",
    "-T",
    'commit_id.short() ++ " " ++ description.first_line() ++ "\\n"',
  ]);
  if (conflicts.trim())
    throw new Error(
      `Rebase produced conflicts; resolve them in this workspace and retry:\n${conflicts}`,
    );
}

const formatDuration = (ms) => (ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`);

const waitForLandingSlot = (context, onProgress = (line) => console.log(line)) => ({
  label: `jj:${context.current.name}`,
  onWait: ({ ahead, holder }) => onProgress(`[verify] waiting for the verification slot: ${ahead} landing${ahead === 1 ? "" : "s"} ahead${holder ? ` (${holder} holds it)` : ""}`),
});

async function runVerification(context, onProgress = (line) => console.log(line)) {
  // One landing verifies at a time on this machine; a landing already holds it.
  return await withVerificationSlot(() => runVerificationInSlot(context, onProgress), waitForLandingSlot(context, onProgress));
}

async function runVerificationInSlot(context, onProgress) {
  const env = verificationSlotEnvironment();
  const passed = [];
  const gaps = [];
  const checks = context.configuration.requiredLocalVerification;
  for (const [index, check] of checks.entries()) {
    if (!check || typeof check.executable !== "string" || !Array.isArray(check.args)) {
      throw new Error(".peach/execution.json contains malformed requiredLocalVerification");
    }
    const args = check.args.map((value) => String(value));
    const cwd =
      typeof check.cwd === "string" ? join(context.current.root, check.cwd) : context.current.root;
    if (check.capability) {
      const probe = check.capability.probe;
      const probeCwd = typeof probe.cwd === "string" ? join(context.current.root, probe.cwd) : context.current.root;
      const probeResult = await run(probe.executable, probe.args, { cwd: probeCwd, env });
      const availability = classifyCapabilityProbe(check.capability, probeResult);
      if (availability.status === "failed") throw new Error(`Capability probe failed for ${check.capability.id}: ${availability.reason}`);
      if (availability.status === "unavailable") {
        const declared = `${check.executable} ${args.join(" ")}`.trim();
        onProgress(`[verify ${index + 1}/${checks.length}] unavailable ${check.capability.id}: ${availability.reason}`);
        gaps.push(verificationGap(check.capability, declared, probeResult, availability.reason));
        continue;
      }
    }
    const declared = `${check.executable} ${args.join(" ")}`.trim();
    onProgress(`[verify ${index + 1}/${checks.length}] ${declared}`);
    const started = Date.now();
    const result = await run(check.executable, args, { cwd, env });
    if (result.code !== 0) {
      // Verification output is evidence for a failure, not a live feed: inheriting the
      // terminal paints thousands of test lines over an embedding TUI such as Pi.
      throw new Error(`Required verification failed: ${declared} (exit ${result.code})\n${summarizeVerificationFailure(result)}`);
    }
    onProgress(`[verify ${index + 1}/${checks.length}] passed in ${formatDuration(Date.now() - started)}`);
    passed.push(declared);
  }
  return verificationEvidence(passed, gaps, context.configuration.requiredLocalVerification);
}

async function ensureLandingDescription(cwd, context, target) {
  if (target.description.trim()) return target;
  const metadata = await workspaceMetadata(context.current.name);
  const issueNumber = typeof metadata?.issueNumber === "number" ? metadata.issueNumber : null;
  const issueDescription = issueNumber
    ? await issueTitle(context.integration.root, issueNumber)
    : null;
  const taskDescription = typeof metadata?.task === "string" ? metadata.task.trim() : "";
  const description = (
    issueDescription?.trim() ||
    taskDescription ||
    `Land ${context.current.name}`
  ).slice(0, 500);
  await jj(cwd, ["describe", "-r", target.changeId, "-m", description]);
  return revisionFacts(cwd, target.changeId);
}

/** The remote this landing publishes to, or null for local-only/undeclared delivery. */
function publicationRemote(context, localOnly) {
  return localOnly === true ? null : context.configuration.remote ?? null;
}

const fetchIntegration = (cwd, remote, branch) => run("jj", ["--color=never", "git", "fetch", "--remote", remote, "--branch", branch], { cwd });

/** Push the integration bookmark and confirm the remote-tracking bookmark contains the artifact. */
async function publishIntegration(cwd, remote, branch, commitId) {
  // A colocated import can leave the remote bookmark untracked; jj refuses to push it then.
  await run("jj", ["--color=never", "bookmark", "track", `${branch}@${remote}`], { cwd });
  const pushed = await run("jj", ["--color=never", "git", "push", "--remote", remote, "--bookmark", branch], { cwd });
  // A remote that another landing already advanced past this artifact also counts.
  if (pushed.code !== 0) await fetchIntegration(cwd, remote, branch);
  if (await revisionExists(cwd, `${commitId} & ::${branch}@${remote}`)) {
    return { ok: true, status: "pushed", remote, branch, commitId };
  }
  const detail = (pushed.stderr || pushed.stdout).trim();
  return { ok: false, status: "push_failed", remote, branch, commitId,
    reason: `Push of ${branch} to ${remote} failed${detail ? `: ${detail}` : ""}. The local integration is kept; rerun land to retry the push.` };
}

/** Landing is one operation: fetch → rebase → verify → move bookmark → push. */
export async function landWorkspace(cwd = process.cwd(), options = {}) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") throw new Error("Landing requires an isolated jj workspace");
  if (options.localOnly !== undefined && typeof options.localOnly !== "boolean") throw new Error("localOnly must be an explicit boolean");
  const remote = publicationRemote(context, options.localOnly);
  const onProgress = options.onProgress ?? ((line) => console.log(line));
  // One landing at a time holds the machine-wide slot from fetch through push, so
  // the integration branch cannot move between this landing's rebase and bookmark.
  return await withVerificationSlot(() => landInSlot(cwd, context, remote, options), waitForLandingSlot(context, onProgress));
}

async function landInSlot(cwd, context, remote, options) {
  // Rebase onto the latest published integration; an offline fetch surfaces again at push.
  if (remote) await fetchIntegration(cwd, remote, context.integrationBranch);
  const result = await withWorkspaceTransaction(`writer:${context.current.name}`, async () => {
    const prior = await readJsonOptional(statePath(context.current.name));
    if (prior?.phase === "landed" && prior.workspacePath === context.current.root && prior.integrationRoot === context.integration.root && !await workspaceHasUnintegratedWork(cwd, context.integrationBranch)
      && await revisionExists(cwd, `${prior.artifactCommitId} & ::${context.integrationBranch}`)) {
      return { context, artifact: await revisionFacts(cwd, prior.artifactCommitId),
        verification: prior.verificationEvidence ?? { status: "passed", passed: prior.verificationCommands ?? [], gaps: [], policyDigest: "legacy" } };
    }
    await assertWorkspaceMutationAllowed(context);
    const lock = await activeWorkspaceLock(context.current.name);
    const refusal = workspaceLandingWriterRefusal(lock && { ...lock, workspaceName: context.current.name });
    if (refusal) throw new Error(refusal);
    const release = lock ? async () => {} : await acquireWorkspaceLockUnlocked(context);
    try { return await landOwnedWorkspace(cwd, context, options); } finally { await release(); }
  });
  return { ...result, ...await completeLanding(cwd, context, result.artifact.commitId, options) };
}

/**
 * The tail every landing shares once the integration bookmark has moved: the
 * repository's declared external-state step (for example a development database
 * migration), then the push. A blocked or failed step keeps the local
 * integration; rerunning land retries it without re-verifying landed source.
 */
export async function completeLanding(cwd, context, commitId, options = {}) {
  const gitDirectory = await jj(cwd, ["--ignore-working-copy", "git", "root"]);
  const postIntegration = await finalizePostIntegration({
    gitDirectory, integratedCommitSha: commitId, approval: options.postIntegrationApproval,
    readIntegrationTip: async () => (await revisionFacts(cwd, context.integrationBranch)).commitId,
    ...(options.environment ? { environment: options.environment } : {}),
  });
  if (!postIntegration.ok) {
    return { ok: false, postIntegration, publication: { ok: false, status: "blocked", commitId,
      reason: `Post-integration ${postIntegration.status}${postIntegration.reason ? `: ${postIntegration.reason}` : ""}. The local integration is kept; resolve it and rerun land.` } };
  }
  const remote = publicationRemote(context, options.localOnly);
  const publication = remote
    ? await publishIntegration(cwd, remote, context.integrationBranch, commitId)
    : { ok: true, status: options.localOnly === true ? "local_only" : "not_declared", commitId };
  return { ok: publication.ok, postIntegration, publication };
}

/** True when the landed artifact is on the declared remote, or when no publication applies. */
export async function artifactPublished(cwd, context, state) {
  const remote = publicationRemote(context, state.localOnly);
  if (!remote) return true;
  await fetchIntegration(cwd, remote, context.integrationBranch);
  return revisionExists(cwd, `${state.artifactCommitId} & ::${context.integrationBranch}@${remote}`);
}

async function landOwnedWorkspace(cwd, context, options) {
  // Queue before rebasing: only the slot holder advances the integration branch,
  // so the base this landing verifies is still current when it integrates.
  return await withVerificationSlot(() => landOwnedWorkspaceInSlot(cwd, options), waitForLandingSlot(context, options.onProgress));
}

async function landOwnedWorkspaceInSlot(cwd, options) {
  const preview = await landingPreview(cwd);
  const { context } = preview;
  const target = await ensureLandingDescription(cwd, context, preview.target);
  await assertDefaultReady(context);
  await jj(cwd, ["rebase", "--branch", target.changeId, "--onto", context.integrationBranch]);
  await assertStackConflictFree(cwd, context.integrationBranch, target.changeId);
  const base = await revisionFacts(cwd, context.integrationBranch);
  const candidate = await revisionFacts(cwd, target.changeId);
  const assertIdentity = async () => {
    const drift = await jj(cwd, ["diff", "--from", candidate.commitId, "--to", "@", "--summary"]);
    if ((await revisionFacts(cwd, target.changeId)).commitId !== candidate.commitId || drift)
      throw new Error("Verification checkout differs from the landing candidate; repair and rerun landing");
    if ((await revisionFacts(cwd, context.integrationBranch)).commitId !== base.commitId)
      throw new Error("Integration bookmark moved; rerun landing against the new base");
  };
  await assertIdentity();
  const verification = await runVerification(context, options.onProgress);
  await assertIdentity();
  await withWorkspaceTransaction(`integrate:${resolve(context.integration.root)}:${context.integrationBranch}`, async () => {
    await assertIdentity();
    await assertDefaultReady(context);
    await writeLandingState(context, candidate, verification, "prepared", options.localOnly);
    await jj(cwd, ["bookmark", "set", context.integrationBranch, "--revision", candidate.commitId]);
    await writeLandingState(context, candidate, verification, "landed", options.localOnly);
    await jj(context.integration.root, ["new", context.integrationBranch]);
  });
  const currentAfter = await revisionFacts(cwd, "@");
  if (!currentAfter.empty) await jj(cwd, ["new", context.integrationBranch]);
  return { context, artifact: candidate, verification };
}

/** Exact source proof (landed, pushed, nothing new) before a session leaves this workspace. */
export async function assertWorkspaceDelivered(cwd) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") throw new Error("No current Issue workspace");
  const state = await readJsonOptional(statePath(context.current.name));
  const metadata = await workspaceMetadata(context.current.name);
  if (!state || state.phase !== "landed" || state.workspaceName !== context.current.name
    || state.workspacePath !== context.current.root || state.integrationRoot !== context.integration.root
    || state.integrationBranch !== context.integrationBranch
    || (state.issueNumber ?? null) !== (metadata?.issueNumber ?? null)
    || !await revisionExists(cwd, `${state.artifactCommitId} & ::${context.integrationBranch}`)
    || await workspaceHasUnintegratedWork(cwd, context.integrationBranch)) {
    throw new Error("Land the current workspace before continuing to another one");
  }
  if (!await artifactPublished(cwd, context, state)) throw new Error("Source integrated locally but not yet pushed; rerun land before continuing");
  return state;
}

export async function prepareWorkspaceContinuation(task, cwd, scopeNumber) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Continuation requires a JJ project");
  if (context.current.name !== "default") await assertWorkspaceDelivered(cwd);
  const issueNumber = await selectImplementationIssue(context.integration.root, scopeNumber, context.integrationBranch, async (executable, args, root) => {
    const result = await run(executable, args, { cwd: root });
    if (result.code !== 0) throw new Error(result.stderr || "Live Issue eligibility unavailable");
    return result.stdout;
  }, (candidateNumber) => findIssueWorkspace(context.integration.root, candidateNumber));
  const existing = issueNumber ? await findIssueWorkspace(cwd, issueNumber) : null;
  if (existing?.lock) throw new Error(workspaceCurrentWriterRefusal({ workspaceName: existing.name, issueNumber, lock: existing.lock }));
  return createWorkspace(task, context.integration.root, { issueNumber });
}

export { cleanupLandedWorkspace, provisionSpare, readySpares } from "./workspace-lifecycle.mjs"; // for the installed launcher/CLI
export { normalizeDeclaredVerification } from "./verification-policy.mjs";
