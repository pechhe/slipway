/** Shared native JJ writer-lock semantics for Peach, vanilla Pi and any other
 * coding-agent surface. The lock sidecar is the single writer authority. */
import { randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.mjs";

export const WORKSPACE_TAKEOVER_TOOL = "peach_workspace_takeover";
const TAKEOVER_AUDIT_LIMIT = 20;

export function workspaceWriterProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function workspaceWriterRecordMustBePreserved(lock) {
  return Boolean(
    lock
    && (workspaceWriterProcessAlive(lock.pid)
      || (typeof lock.ownerAgentRunId === "string" && lock.ownerAgentRunId.trim().length > 0)),
  );
}

// Paths resolve per call so every surface (and every test HOME) shares one root.
const stateHome = () => join(homedir(), ".pi", "agent", "workspace-state");
export const workspaceWriterLockFile = (workspaceName) => join(stateHome(), "locks", `${workspaceName}.json`);
const workspaceMetadataFile = (workspaceName) => join(stateHome(), "workspaces", `${workspaceName}.json`);

async function readJsonOptional(file) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

/** Comparable writer identity. A pending takeover reservation is part of it, so
 * a racer that observed the pre-takeover owner can never also win. */
export function workspaceWriterIdentity(lock) {
  if (!lock) return null;
  return {
    pid: Number.isInteger(lock.pid) ? lock.pid : null,
    surface: typeof lock.surface === "string" ? lock.surface : "pi",
    ownerAgentRunId: typeof lock.ownerAgentRunId === "string" ? lock.ownerAgentRunId : null,
    acquiredAt: typeof lock.acquiredAt === "string" ? lock.acquiredAt : null,
    takeoverId: typeof lock.takeoverId === "string" ? lock.takeoverId : null,
  };
}

const sameIdentity = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export function describeWorkspaceWriter(lock) {
  if (!lock) return "no writer";
  const run = typeof lock.ownerAgentRunId === "string" ? ` Agent Run ${lock.ownerAgentRunId}` : "";
  const surface = lock.surface === "peach" ? "Peach Pi" : lock.surface && lock.surface !== "pi" ? String(lock.surface) : "Pi";
  const state = workspaceWriterProcessAlive(lock.pid) ? "live" : "exited";
  return `${surface}${run} (pid ${lock.pid}, ${state})`;
}

/** The exact supported takeover route, named in every ownership refusal. */
export function workspaceTakeoverInstruction({ workspaceName, issueNumber } = {}) {
  const target = issueNumber ? `issueNumber:${issueNumber}` : `workspaceName:${JSON.stringify(workspaceName)}`;
  const cli = issueNumber ? `pi --issue ${issueNumber} --take-over` : `pi --jj-workspace ${workspaceName} --take-over`;
  return `Only if the user explicitly authorises a takeover: call ${WORKSPACE_TAKEOVER_TOOL} {${target}, humanAuthorised:true, reason} in vanilla Pi, run \`${cli}\`, or use peach_delivery task_start with confirmTakeover:true in Peach.`;
}

export function workspaceCurrentWriterRefusal({ workspaceName, issueNumber, lock }) {
  const subject = issueNumber ? `Issue #${issueNumber} has a current writer in jj:${workspaceName}` : `jj:${workspaceName} has a current writer`;
  return `${subject}: ${describeWorkspaceWriter(lock)}. ${workspaceTakeoverInstruction({ workspaceName, issueNumber })}`;
}

/** Owners displaced by a governed takeover are terminal: they never re-claim. */
export async function workspaceOwnerSuperseded(workspaceName, ownerAgentRunId) {
  if (typeof ownerAgentRunId !== "string" || !ownerAgentRunId) return false;
  const metadata = await readJsonOptional(workspaceMetadataFile(workspaceName));
  return Array.isArray(metadata?.supersededOwnerAgentRunIds) && metadata.supersededOwnerAgentRunIds.includes(ownerAgentRunId);
}

export async function assertWorkspaceOwnerNotSuperseded(workspaceName, ownerAgentRunId) {
  if (await workspaceOwnerSuperseded(workspaceName, ownerAgentRunId)) {
    throw new Error(`Agent Run ${ownerAgentRunId} was taken over in jj:${workspaceName}; it is terminal and cannot re-claim or land this workspace`);
  }
}

/** Landing is allowed only for the current process's own ordinary writer,
 * including one it acquired through takeover. */
export function workspaceLandingWriterRefusal(lock, ownPids = [process.pid, process.ppid]) {
  if (!lock) return null;
  if (lock.surface === "peach" || lock.ownerAgentRunId || lock.revoking || !ownPids.includes(lock.pid)) {
    const owner = workspaceWriterProcessAlive(lock.pid) ? "another live owner" : "a retained owner";
    return `Workspace has ${owner}: ${describeWorkspaceWriter(lock)}. ${workspaceTakeoverInstruction({ workspaceName: lock.workspaceName })}`;
  }
  return null;
}

function validatedTakeover(input) {
  const { workspaceName, workspacePath, authorisation, owner } = input ?? {};
  if (typeof workspaceName !== "string" || !workspaceName || workspaceName === "default") {
    throw new Error("Takeover requires an isolated JJ workspace name");
  }
  if (typeof workspacePath !== "string" || !workspacePath) throw new Error("Takeover requires the workspace path");
  const reason = typeof authorisation?.reason === "string" ? authorisation.reason.trim() : "";
  if (authorisation?.humanAuthorised !== true || !reason || reason.length > 500) {
    throw new Error(`Takeover of jj:${workspaceName} requires explicit human authorisation (humanAuthorised:true and a reason); it is never inferred`);
  }
  if (!owner || typeof owner.surface !== "string" || !owner.surface || !Number.isInteger(owner.pid) || owner.pid <= 0) {
    throw new Error("Takeover requires the new owner's surface and pid");
  }
  if (owner.ownerAgentRunId !== undefined && (typeof owner.ownerAgentRunId !== "string" || !owner.ownerAgentRunId)) {
    throw new Error("Takeover owner Agent Run must be a non-empty string");
  }
  return { workspaceName, workspacePath, reason, owner };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

async function waitForExit(pid, ms) {
  for (let waited = 0; waited < ms; waited += 50) {
    if (!workspaceWriterProcessAlive(pid)) return true;
    await sleep(50);
  }
  return !workspaceWriterProcessAlive(pid);
}

/** Vanilla Pi writers are single-session launchers: SIGTERM, then SIGKILL. A
 * Peach host serves many threads, so its owner is revoked through this lock
 * (every Peach writer preflight rejects a superseded owner), never killed. */
async function releasePreviousOwner(prior, owner) {
  if (!prior || !workspaceWriterProcessAlive(prior.pid) || prior.pid === owner.pid || prior.pid === process.pid) {
    return { previousOwnerLive: false, terminated: false };
  }
  if (prior.surface === "peach") return { previousOwnerLive: true, terminated: false };
  try { process.kill(prior.pid, "SIGTERM"); } catch { /* already exited */ }
  if (!(await waitForExit(prior.pid, 2_000))) {
    try { process.kill(prior.pid, "SIGKILL"); } catch { /* already exited */ }
    if (!(await waitForExit(prior.pid, 1_000))) throw new Error(`Previous writer pid ${prior.pid} did not exit; takeover rolled back`);
  }
  return { previousOwnerLive: true, terminated: true };
}

/** Human-authorised writer takeover shared by every surface. It never touches
 * the JJ change or working copy: only the writer sidecar and its audit move. */
export async function takeOverWorkspaceWriter(input) {
  const { workspaceName, workspacePath, reason, owner } = validatedTakeover(input);
  const lockFile = workspaceWriterLockFile(workspaceName);
  const observed = input.expectedOwner !== undefined
    ? input.expectedOwner
    : workspaceWriterIdentity(await readJsonOptional(lockFile));
  const takeoverId = randomUUID();
  const handoffTo = owner.ownerAgentRunId ?? `${owner.surface}:${owner.pid}`;
  const nextIdentity = { version: 1, pid: owner.pid, surface: owner.surface, workspaceName, workspacePath,
    ...(owner.ownerAgentRunId ? { ownerAgentRunId: owner.ownerAgentRunId } : {}) };

  const reserved = await withWorkspaceTransaction(`writer:${workspaceName}`, async () => {
    const prior = await readJsonOptional(lockFile);
    const current = workspaceWriterIdentity(prior);
    if (!sameIdentity(current, observed)) {
      throw new Error(`jj:${workspaceName} writer changed during takeover (now ${describeWorkspaceWriter(prior)}); re-inspect before retrying`);
    }
    if (prior?.revoking && workspaceWriterProcessAlive(prior.pid) && prior.pid !== owner.pid) {
      throw new Error(`jj:${workspaceName} already has a writer revocation or takeover in progress`);
    }
    // An interrupted reservation (its taker exited) still names the real previous owner.
    const priorIdentity = prior?.revoking && prior.takenOverFrom ? prior.takenOverFrom : current;
    if (priorIdentity && !prior?.revoking && priorIdentity.pid === owner.pid && priorIdentity.surface === owner.surface
      && priorIdentity.ownerAgentRunId === (owner.ownerAgentRunId ?? null)) {
      return { prior, previous: priorIdentity, unchanged: true };
    }
    await mkdir(join(stateHome(), "locks"), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(lockFile, {
      ...nextIdentity, acquiredAt: new Date().toISOString(),
      revoking: true, handoffTo, takeoverId, takenOverFrom: priorIdentity,
    });
    return { prior, previous: priorIdentity, unchanged: false };
  });
  if (reserved.unchanged) {
    return { workspaceName, changed: false, previousOwner: reserved.previous, owner: nextIdentity };
  }

  let released;
  try {
    released = await releasePreviousOwner(reserved.previous, owner);
  } catch (error) {
    await withWorkspaceTransaction(`writer:${workspaceName}`, async () => {
      const current = await readJsonOptional(lockFile);
      if (current?.takeoverId === takeoverId && reserved.prior) await writeWorkspaceJson(lockFile, reserved.prior);
    });
    throw error;
  }

  const at = new Date().toISOString();
  const previousOwner = reserved.previous;
  await withWorkspaceTransaction(`writer:${workspaceName}`, async () => {
    const current = await readJsonOptional(lockFile);
    if (current?.takeoverId !== takeoverId) throw new Error(`jj:${workspaceName} takeover reservation was lost; re-inspect before retrying`);
    await writeWorkspaceJson(lockFile, {
      ...nextIdentity, acquiredAt: at,
      takenOverFrom: previousOwner ? { ...previousOwner, takeoverId, at } : null,
    });
    const metadataFile = workspaceMetadataFile(workspaceName);
    const metadata = await readJsonOptional(metadataFile);
    const superseded = new Set(Array.isArray(metadata?.supersededOwnerAgentRunIds) ? metadata.supersededOwnerAgentRunIds : []);
    if (previousOwner?.ownerAgentRunId) superseded.add(previousOwner.ownerAgentRunId);
    if (owner.ownerAgentRunId) superseded.delete(owner.ownerAgentRunId);
    const entry = { takeoverId, at, reason, previousOwner, owner: { surface: owner.surface, pid: owner.pid, ownerAgentRunId: owner.ownerAgentRunId ?? null }, ...released };
    await mkdir(join(stateHome(), "workspaces"), { recursive: true, mode: 0o700 });
    await writeWorkspaceJson(metadataFile, {
      version: 1, workspaceName, workspacePath, ...metadata,
      supersededOwnerAgentRunIds: [...superseded],
      takeovers: [...(Array.isArray(metadata?.takeovers) ? metadata.takeovers : []), entry].slice(-TAKEOVER_AUDIT_LIMIT),
    });
  });
  return { workspaceName, changed: true, takeoverId, at, previousOwner, owner: nextIdentity, ...released };
}
