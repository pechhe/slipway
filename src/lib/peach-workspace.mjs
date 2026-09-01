import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { access, mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

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

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function lockPath(workspaceName) {
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
  if (processAlive(lock.pid)) return lock;
  await rm(path, { force: true });
  return null;
}

export async function acquireWorkspaceLock(context, options = {}) {
  if (!context || context.current.name === "default") return async () => {};
  await mkdir(LOCK_HOME, { recursive: true, mode: 0o700 });
  const path = lockPath(context.current.name);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const active = await activeWorkspaceLock(context.current.name);
    if (active) {
      if (active.surface === "peach") {
        throw new Error(
          `jj:${context.current.name} is owned by Peach Pi (pid ${active.pid}). Close that Peach thread or stop the app first; vanilla Pi will not auto-terminate Peach.`,
        );
      }
      if (!options.takeOver) {
        throw new Error(
          `jj:${context.current.name} is already owned by Pi process ${active.pid}. Stop it first or pass --take-over.`,
        );
      }
      process.kill(active.pid, "SIGTERM");
      for (let wait = 0; wait < 40; wait += 1) {
        const owner = await readJsonOptional(path);
        if (owner?.pid !== active.pid) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 50));
      }
      const owner = await readJsonOptional(path);
      if (owner?.pid === active.pid && processAlive(active.pid)) {
        process.kill(active.pid, "SIGKILL");
      }
      await rm(path, { force: true });
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
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const current = await readJsonOptional(path);
        if (current?.pid === process.pid) await rm(path, { force: true });
      };
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
      env: process.env,
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

export async function workspaceContext(cwd = process.cwd()) {
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
  const current = workspaces.find((entry) => resolve(entry.root) === resolve(currentRoot));
  if (!current) throw new Error("Current jj workspace is not registered");
  const integration = workspaces.find((entry) => entry.name === "default");
  if (!integration) throw new Error("The canonical jj workspace named 'default' is missing");
  const configuration = await readConfiguration(integration.root);
  const integrationBranch = configuration.integrationBranch ?? (await inferIntegrationBranch(cwd));
  if (!(await revisionExists(cwd, integrationBranch))) {
    throw new Error(
      `Configured integration bookmark '${integrationBranch}' does not exist locally`,
    );
  }
  return { current, integration, integrationBranch, configuration };
}

async function readConfiguration(root) {
  try {
    const parsed = JSON.parse(await readFile(join(root, ".peach", "execution.json"), "utf8"));
    return {
      integrationBranch:
        typeof parsed.integrationBranch === "string" ? parsed.integrationBranch : undefined,
      requiredLocalVerification: Array.isArray(parsed.requiredLocalVerification)
        ? parsed.requiredLocalVerification
        : [],
    };
  } catch {
    return { requiredLocalVerification: [] };
  }
}

async function revisionExists(cwd, revision) {
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

function metadataPath(workspaceName) {
  return join(METADATA_HOME, `${workspaceName}.json`);
}

async function workspaceMetadata(workspaceName) {
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
    workspaces.find((workspace) => resolve(workspace.root) === resolve(context.current.root)) ??
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
  await jj(context.integration.root, [
    "--ignore-working-copy",
    "workspace",
    "forget",
    workspaceName,
  ]);
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

async function workspaceHasUnintegratedWork(workspaceRoot, integrationBranch) {
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

async function reusableWorkspace(cwd, projectPrefix, integrationBranch) {
  for (const workspace of await listWorkspaces(cwd)) {
    if (workspace.name === "default" || !workspace.name.startsWith(`${projectPrefix}-`)) continue;
    if (!workspace.root || workspace.lock || workspace.metadata?.issueNumber) continue;
    const relativePath = workspace.root.startsWith(`${WORKSPACE_HOME}/`);
    if (!relativePath) continue;
    if (await workspaceHasUnintegratedWork(workspace.root, integrationBranch)) continue;
    await jj(workspace.root, ["rebase", "-r", "@", "--onto", integrationBranch]);
    return await workspaceContext(workspace.root);
  }
  return null;
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

export async function attachWorkspaceIssue(cwd, issueNumber) {
  if (!Number.isInteger(issueNumber) || issueNumber <= 0)
    throw new Error("Issue number must be a positive integer");
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default")
    throw new Error("Attach Issues only to isolated JJ workspaces");
  await assertIssueAvailable(cwd, issueNumber, context.current.name);
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

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Bun/npm share a global package cache, so a fresh install is fast and, more
 *  importantly, authoritative: bun resolves exactly the workspace lockfile.
 *  Copying the canonical checkout's node_modules was tried earlier but could
 *  propagate a stale canonical install (a newer node_modules mtime than the
 *  lockfile is not a reliable freshness signal), so installs always go
 *  through the package manager. */
async function materializeDependencies(workspacePath) {
  if (!(await fileExists(join(workspacePath, "package.json")))) return false;
  const useBun =
    (await fileExists(join(workspacePath, "bun.lock"))) ||
    (await fileExists(join(workspacePath, "bun.lockb")));
  const command = useBun ? "bun" : "npm";
  const args = useBun
    ? ["install", "--frozen-lockfile", "--prefer-offline", "--backend=clonefile"]
    : ["install"];
  console.log(`[deps] ${command} install in ${basename(workspacePath)}...`);
  const result = await run(command, args, { cwd: workspacePath, inherit: true });
  if (result.code !== 0) {
    throw new Error(
      `Dependency installation failed in ${workspacePath}; fix it before starting Pi here.`,
    );
  }
  return true;
}

export async function prepareWorkspaceDependencies(workspacePath) {
  await materializeDependencies(workspacePath);
}

export async function createWorkspace(task, cwd = process.cwd(), options = {}) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Workspace isolation requires a Jujutsu repository");
  if (context.current.name !== "default") {
    await writeWorkspaceTaskMetadata(context, task);
    if (options.issueNumber) await attachWorkspaceIssue(context.current.root, options.issueNumber);
    return { ...context, created: false, workspacePath: context.current.root };
  }
  const project = slug(basename(context.integration.root), 24);
  if (!options.issueNumber) {
    const reusable = await reusableWorkspace(cwd, project, context.integrationBranch);
    if (reusable) {
      const reusedName = options.issueNumber
        ? `${project}-i${options.issueNumber}`
        : taskWorkspaceName(project);
      if (reusable.current.name !== reusedName)
        await renameWorkspace(reusable.current.root, reusedName);
      const reusedContext = await workspaceContext(reusable.current.root);
      if (!reusedContext) throw new Error("Reused JJ workspace disappeared during rename");
      await writeWorkspaceTaskMetadata(reusedContext, task);
      await prepareWorkspaceDependencies(reusable.current.root);
      return {
        ...reusedContext,
        created: false,
        reused: true,
        workspacePath: reusable.current.root,
      };
    }
  }
  const name = taskWorkspaceName(project, options.issueNumber);
  await assertIssueAvailable(cwd, options.issueNumber, name);
  const workspacePath = join(WORKSPACE_HOME, name);
  await mkdir(WORKSPACE_HOME, { recursive: true, mode: 0o700 });
  await jj(cwd, [
    "workspace",
    "add",
    "--name",
    name,
    "--revision",
    context.integrationBranch,
    workspacePath,
  ]);
  const created = await workspaceContext(workspacePath);
  if (!created || created.current.name !== name)
    throw new Error("Created workspace could not be verified");
  await writeWorkspaceTaskMetadata(created, task);
  if (options.issueNumber) await attachWorkspaceIssue(workspacePath, options.issueNumber);
  await prepareWorkspaceDependencies(workspacePath);
  return { ...created, created: true, reused: false, workspacePath };
}

async function revisionFacts(cwd, revision) {
  const output = await jj(cwd, [
    "log",
    "-r",
    revision,
    "--no-graph",
    "-T",
    'change_id ++ "\\t" ++ commit_id ++ "\\t" ++ empty ++ "\\t" ++ conflict ++ "\\t" ++ description.first_line() ++ "\\n"',
  ]);
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
  const facts = await revisionFacts(context.integration.root, "@");
  if (facts.conflict)
    throw new Error("Canonical checkout has conflicts; preserving both workspaces");
  if (!facts.empty)
    throw new Error(
      "Canonical checkout has unintegrated changes; preserve or reconcile them before landing",
    );
  return facts;
}

function statePath(workspaceName) {
  return join(STATE_HOME, `${workspaceName}.json`);
}

async function writeLandingState(context, artifact) {
  await mkdir(STATE_HOME, { recursive: true, mode: 0o700 });
  await writeFile(
    statePath(context.current.name),
    JSON.stringify(
      {
        version: 1,
        workspaceName: context.current.name,
        workspacePath: context.current.root,
        integrationRoot: context.integration.root,
        integrationBranch: context.integrationBranch,
        artifactCommitId: artifact.commitId,
        landedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
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
  const stat = await jj(cwd, [
    "diff",
    "--from",
    context.integrationBranch,
    "--to",
    targetRevision,
    "--stat",
  ]);
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

async function runVerification(context) {
  for (const check of context.configuration.requiredLocalVerification) {
    if (!check || typeof check.executable !== "string" || !Array.isArray(check.args)) {
      throw new Error(".peach/execution.json contains malformed requiredLocalVerification");
    }
    const args = check.args.map((value) => String(value));
    const cwd =
      typeof check.cwd === "string" ? join(context.current.root, check.cwd) : context.current.root;
    console.log(`\n[verify] ${check.executable} ${args.join(" ")}`);
    const result = await run(check.executable, args, { cwd, inherit: true });
    if (result.code !== 0)
      throw new Error(`Required verification failed: ${check.executable} ${args.join(" ")}`);
  }
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

export async function landWorkspace(cwd = process.cwd()) {
  const preview = await landingPreview(cwd);
  const { context } = preview;
  const target = await ensureLandingDescription(cwd, context, preview.target);
  await assertDefaultReady(context);

  await jj(cwd, ["rebase", "--branch", target.changeId, "--onto", context.integrationBranch], {
    inherit: true,
  });
  await assertStackConflictFree(cwd, context.integrationBranch, target.changeId);
  await runVerification(context);
  await assertDefaultReady(context);

  await jj(cwd, ["bookmark", "set", context.integrationBranch, "--revision", target.changeId], {
    inherit: true,
  });
  await jj(context.integration.root, ["new", context.integrationBranch], { inherit: true });

  const currentAfter = await revisionFacts(cwd, "@");
  if (!currentAfter.empty) await jj(cwd, ["new", context.integrationBranch], { inherit: true });
  const artifact = await revisionFacts(cwd, target.changeId);
  await writeLandingState(context, artifact);
  return { context, artifact };
}

export async function cleanupLandedWorkspace(cwd = process.cwd()) {
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
  const integrated = await revisionExists(
    context.integration.root,
    `${state.artifactCommitId} & ::${state.integrationBranch}`,
  );
  if (!integrated)
    throw new Error("Cannot prove the landed artifact is integrated; workspace retained");
  await jj(context.integration.root, ["workspace", "forget", context.current.name]);
  await rm(context.current.root, { recursive: true, force: true });
  await rm(statePath(context.current.name), { force: true });
  await rm(metadataPath(context.current.name), { force: true });
  await rm(lockPath(context.current.name), { force: true });
  return { cleaned: true };
}
