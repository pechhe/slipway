import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

// Only short native identity/owner transitions are serialized here. Never use
// this repository key around model work, verification or a connector request.
// `onState` is observability for this authoritative lock lifecycle, not a second
// queue or ownership mechanism. `acquired` is emitted only after proper-lockfile
// actually grants the transaction lock.
// This mirror contains only locks acquired by this process and is updated after
// the real filesystem lock succeeds. It may therefore omit an external owner,
// but it must never invent or override one.
const acquiredOwners = new Map();

export async function withWorkspaceTransaction(key, operation, options = {}) {
  const root = join(homedir(), ".pi", "agent", "workspace-state", "transactions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, createHash("sha256").update(key).digest("hex"));
  const queuedAt = Date.now();
  options.onState?.({
    phase: "queued",
    key,
    ...(options.operationId ? { operationId: options.operationId } : {}),
    ...(acquiredOwners.get(key) ? { blockedByOperationId: acquiredOwners.get(key) } : {}),
  });
  const release = await lockfile.lock(target, {
    realpath: false, stale: 120000, update: 10000,
    retries: { retries: 200, minTimeout: 25, maxTimeout: 100 },
  });
  const acquiredAt = Date.now();
  if (options.operationId) acquiredOwners.set(key, options.operationId);
  options.onState?.({
    phase: "acquired",
    key,
    ...(options.operationId ? { operationId: options.operationId } : {}),
    ...(options.operationId ? { ownerOperationId: options.operationId } : {}),
    queueWaitMs: Math.max(0, acquiredAt - queuedAt),
  });
  try { return await operation(); } finally {
    const releasedState = {
      phase: "released",
      key,
      ...(options.operationId ? { operationId: options.operationId } : {}),
      queueWaitMs: Math.max(0, acquiredAt - queuedAt),
      criticalSectionMs: Math.max(0, Date.now() - acquiredAt),
    };
    await release();
    if (options.operationId && acquiredOwners.get(key) === options.operationId) acquiredOwners.delete(key);
    options.onState?.(releasedState);
  }
}

export async function writeWorkspaceJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
