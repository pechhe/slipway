import { integrateLandingCandidate, finishLanding } from "./landing-candidate.mjs";
import { declaredPublicationRemote } from "./source-publication-policy.mjs";
import { LANDED_WORKSPACE_REFUSAL, workspaceContinuationDisposition } from "./workspace-delivery-lifecycle.mjs";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.mjs";
import { runRequiredVerification } from "./required-verification.mjs";
import { withVerificationSlot } from "./verification-slot.mjs";
import { assertNoForeignPrimaryWriter } from "./primary-checkout-writer.mjs";

import { claimSpare } from "./workspace-lifecycle.mjs";
import { sweepDisposableWorkspaces } from "./workspace-sweep.mjs";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { finalizePostIntegration } from "./post-integration-finalization.mjs";
import { postIntegrationPolicy } from "./post-integration-policy.mjs";
import { describePostLandFailure, latestPostLandResult, postLandChecks, startPostLandVerification } from "./post-land-verification.mjs";
import { mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { normalizeVerificationDeclaration } from "./verification-policy.mjs";

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

/** The nearest ancestor holding `.jj`, which is how `jj workspace root` resolves
 *  a checkout. Every workspace operation starts here, so it avoids a process. */
export async function jjWorkspaceRoot(cwd) {
  let dir;
  try { dir = await realpath(cwd); } catch { return null; }
  for (;;) {
    if (await stat(join(dir, ".jj")).then((entry) => entry.isDirectory(), () => false)) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

async function sameDirectory(left, right) {
  if (!left || !right) return false;
  const [a, b] = await Promise.all([realpath(left).catch(() => resolve(left)), realpath(right).catch(() => resolve(right))]);
  return a === b;
}

export async function workspaceContext(cwd = process.cwd(), integratedBranch) {
  const currentRoot = await jjWorkspaceRoot(cwd);
  if (!currentRoot) return null;
  let output;
  try {
    output = await jj(cwd, [
      "--ignore-working-copy",
      "workspace",
      "list",
      "-T",
      'name ++ "\\t" ++ root ++ "\\t" ++ target.change_id() ++ "\\t" ++ target.commit_id() ++ "\\n"',
    ]);
  } catch {
    return null;
  }
  const workspaces = parseWorkspaceList(output);
  // An empty root is an unavailable checkout, never this process cwd.
  let current = null;
  for (const entry of workspaces) if (await sameDirectory(entry.root, currentRoot)) { current = entry; break; }
  if (!current) throw new Error("Current jj workspace is not registered");
  const integration = workspaces.find((entry) => entry.name === "default");
  if (!integration?.root) throw new Error("The canonical jj workspace named 'default' is missing or unavailable");
  const configuration = integratedBranch ? { integrationBranch: integratedBranch, requiredLocalVerification: [] } : await readConfiguration(integration.root);
  // An inferred bookmark was just proven to exist.
  const integrationBranch = configuration.integrationBranch ?? (await inferIntegrationBranch(cwd));
  if (configuration.integrationBranch && !(await revisionExists(cwd, integrationBranch))) {
    throw new Error(
      `Configured integration bookmark '${integrationBranch}' does not exist locally`,
    );
  }
  return { current, integration, integrationBranch, configuration };
}

/** The landing configuration from `.peach/execution.json`, read the same way by every runtime. */
export async function readConfiguration(root) {
  let raw;
  try { raw = await readFile(join(root, ".peach", "execution.json"), "utf8"); }
  catch (error) { if (error?.code === "ENOENT") return { requiredLocalVerification: [], postLandVerification: [] }; throw error; }
  const parsed = JSON.parse(raw);
  postIntegrationPolicy(parsed?.postIntegration);
  const remote = declaredPublicationRemote(parsed);
  const checks = parsed?.requiredLocalVerification ?? [];
  if (!parsed || typeof parsed !== "object" || !Array.isArray(checks)) throw new Error("Malformed required local verification policy");
  const requiredLocalVerification = checks.map((entry, index) => normalizeVerificationDeclaration(entry, `requiredLocalVerification[${index}]`));
  return { parallelExecution: parsed.parallelExecution === true,
    integrationBranch: typeof parsed.integrationBranch === "string" ? parsed.integrationBranch : undefined, requiredLocalVerification,
    postLandVerification: postLandChecks(parsed.postLandVerification), remote };
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
          : await workspaceHasUnintegratedWork(workspace.root, context.integrationBranch).catch(() => true),
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

async function assertIssueAvailable(cwd, issueNumber, intendedWorkspace) {
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
  const result = await run(dependencyCommand.command, dependencyCommand.args, { cwd: workspacePath, inherit: !options.quiet, env: options.env });
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
    if (options.issueNumber) {
      const existing = await findIssueWorkspace(cwd, options.issueNumber);
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
  // Never change files underneath a live Direct checkout writer. A Direct
  // landing runs from the primary checkout itself and is that single writer.
  if (context.current.name !== "default") await assertNoForeignPrimaryWriter(context.integration.root);
  const facts = await revisionFacts(context.integration.root, "@");
  if (facts.conflict) throw new Error("Canonical checkout has conflicts; preserving both workspaces");
  if (!facts.empty) throw new Error("Canonical checkout has unintegrated changes; preserve or reconcile them before landing");
  if (await jj(context.integration.root, ["log", "-r", `parents(@) ~ ::${context.integrationBranch}`, "--no-graph", "-T", "commit_id"]))
    throw new Error("Canonical checkout has unintegrated ancestry; preserve it before landing");
  return facts;
}

export function statePath(workspaceName) {
  return join(STATE_HOME, `${workspaceName}.json`);
}

async function writeLandingState(context, artifact, verification, phase = "landed", localOnly, operationId) {
  await mkdir(STATE_HOME, { recursive: true, mode: 0o700 });
  const metadata = await workspaceMetadata(context.current.name);
  const landedAt = new Date().toISOString();
  await writeWorkspaceJson(statePath(context.current.name), {
    version: 1, phase, operationId, cleanupPending: true, ...(localOnly !== undefined ? { localOnly } : {}), workspaceName: context.current.name, workspacePath: context.current.root,
    integrationRoot: context.integration.root, integrationBranch: context.integrationBranch,
    artifactCommitId: artifact.commitId, artifactChangeId: artifact.changeId,
    artifactDescription: artifact.description, verification: verification.status,
    verificationCommands: verification.passed, verificationEvidence: verification, landedAt,
    workspaceImplementationChangeId: metadata?.implementationChangeId,
    // No archive period: a delivered checkout is eligible for cleanup at landing.
    cleanupEligibleAt: landedAt,
    ...(typeof metadata?.issueNumber === "number" ? { issueNumber: metadata.issueNumber } : {}),
  });
}

export async function landingPreview(cwd = process.cwd(), options = {}) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Not inside a Jujutsu repository");
  if (context.current.name === "default" && !options.allowDefaultWorkspace)
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

const waitForLandingSlot = (context, onProgress = (line) => console.log(line)) => ({
  scope: context.integration.root,
  label: `jj:${context.current.name}`,
  onWait: ({ ahead, holder }) => onProgress(`[verify] waiting for the verification slot: ${ahead} landing${ahead === 1 ? "" : "s"} ahead${holder ? ` (${holder} holds it)` : ""}`),
});

async function runVerification(context, onProgress = (line) => console.log(line)) {
  // One landing of this repository verifies at a time; a landing already holds the slot.
  return await runRequiredVerification({ root: context.current.root, checks: context.configuration.requiredLocalVerification,
    onProgress, slot: waitForLandingSlot(context, onProgress) });
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
  if (!context || (context.current.name === "default" && !options.allowDefaultWorkspace)) throw new Error("Landing requires an isolated jj workspace");
  options.onStage?.("preparing");
  if (options.localOnly !== undefined && typeof options.localOnly !== "boolean") throw new Error("localOnly must be an explicit boolean");
  const remote = publicationRemote(context, options.localOnly);
  const onProgress = options.onProgress ?? ((line) => console.log(line));
  // A failed background run on this repository is the next landing's to see.
  const postLandFailure = describePostLandFailure(await latestPostLandResult(context.integration.root));
  if (postLandFailure) onProgress(`[post-land] ${postLandFailure}`);
  // One landing at a time holds this repository's slot from fetch through push, so
  // the integration branch cannot move between this landing's rebase and bookmark.
  const result = await withVerificationSlot(() => landInSlot(cwd, context, remote, options), waitForLandingSlot(context, onProgress));
  // Started outside the landing slot, so an in-process run queues on its own.
  const started = { ...result, ...await startPostLand(cwd, context, result, options.postLandRunner, options.environment) };
  // Release other disposable checkouts after every CLI/extension landing. A host
  // with its own checkout housekeeping (Peach's adapter) releases its records
  // itself. The sweep never fails the landing.
  if (result.ok && !options.adapter?.finish) await sweepDisposableWorkspaces(context.integration.root, { protectedRoots: [cwd, context.current.root] }).catch(() => undefined);
  return postLandFailure ? { ...started, postLandWarning: postLandFailure } : started;
}

async function landInSlot(cwd, context, remote, options) {
  // Rebase onto the latest published integration; an offline fetch surfaces again at push.
  if (remote) await fetchIntegration(cwd, remote, context.integrationBranch);
  const integrate = async () => {
    const prior = await readJsonOptional(statePath(context.current.name));
    if (prior?.phase === "landed" && prior.workspacePath === context.current.root && prior.integrationRoot === context.integration.root && !await workspaceHasUnintegratedWork(cwd, context.integrationBranch)
      && await revisionExists(cwd, `${prior.artifactCommitId} & ::${context.integrationBranch}`)) {
      const cleanup = await finishLanding(context, prior, options, landingIO);
      return { context, artifact: await revisionFacts(cwd, prior.artifactCommitId), ...cleanup,
        verification: prior.verificationEvidence ?? { status: "passed", passed: prior.verificationCommands ?? [], gaps: [], policyDigest: "legacy" } };
    }
    if (context.current.name !== "default") await assertWorkspaceMutationAllowed(context);
    return landOwnedWorkspace(cwd, options);
  };
  const result = await integrate();
  const completed = await completeLanding(cwd, context, result.artifact.commitId, options);
  return { ...result, ...completed };
}

/** A fresh integration starts the repository's declared background verification. */
async function startPostLand(cwd, context, result, runner, environment) {
  const checks = context.configuration.postLandVerification ?? [];
  if (!result.base || !checks.length) return {};
  try {
    const gitDirectory = await jj(cwd, ["--ignore-working-copy", "git", "root"]);
    const record = await startPostLandVerification({ integrationRoot: context.integration.root, gitDirectory, base: result.base, commit: result.artifact.commitId, checks, runner,
      // The host's command environment, as for the landing's own verification.
      ...(environment ? { env: environment() } : {}) });
    return { postLand: { status: record.status, commit: record.commit, log: record.log } };
  } catch (error) {
    // The integration stands; only its background evidence is missing.
    return { postLand: { status: "not_started", reason: error instanceof Error ? error.message : String(error) } };
  }
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
    // A retry after a later landing: a completed descendant with unchanged migration
    // inputs covers this artifact, or its exact source runs; drift still fails closed.
    recoverDescendant: true,
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

// Called inside landWorkspace's slot: only the slot holder advances the integration
// branch, so the base this landing verifies is still current when it integrates.
function landOwnedWorkspace(cwd, options) {
  return integrateLandingCandidate(cwd, options, {
    ...landingIO,
    landingPreview: (root) => landingPreview(root, { allowDefaultWorkspace: options.allowDefaultWorkspace }),
  });
}

const landingIO = {
  landingPreview, ensureLandingDescription, assertDefaultReady, jj,
  assertStackConflictFree, revisionFacts, runVerification, writeLandingState,
  readJsonOptional, statePath,
};

/** Retry the housekeeping of a landing whose integration already stands. */
export function finishLandedWorkspace(context, state) {
  return finishLanding(context, state, {}, landingIO);
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

/** A fresh workspace for this conversation's next task, once the current one is delivered. */
export async function prepareWorkspaceContinuation(task, cwd) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Continuation requires a JJ project");
  if (context.current.name !== "default") await assertWorkspaceDelivered(cwd);
  return createWorkspace(task, context.integration.root);
}

export { cleanupLandedWorkspace, describeRetention, provisionSpare, readySpares, retainedWorkspaceMaterial } from "./workspace-lifecycle.mjs"; // for the installed launcher/CLI
export { pruneEmptyWorkspaces, sweepDisposableWorkspaces } from "./workspace-sweep.mjs";
export { normalizeDeclaredVerification } from "./verification-policy.mjs";
// For the installed CLI, which reports runs and is its own detached runner.
export { latestPostLandResult, runPostLandVerification } from "./post-land-verification.mjs";
