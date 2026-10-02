import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import lockfile from "proper-lockfile";

// Only short native identity/owner transitions are serialized here. Never use
// this repository key around model work, verification or a connector request.
// With `wait: false` a held transaction fails at once with code ELOCKED.
export async function withWorkspaceTransaction(key, operation, options = {}) {
  const root = join(homedir(), ".pi", "agent", "workspace-state", "transactions");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, createHash("sha256").update(key).digest("hex"));
  const release = await lockfile.lock(target, {
    realpath: false, stale: 120000, update: 10000,
    // A healthy holder refreshes every 10 seconds. Wait beyond the stale
    // boundary so loaded workspace provisioning serializes instead of failing
    // while that holder is still making progress.
    retries: options.wait === false ? 0 : { retries: 1400, minTimeout: 25, maxTimeout: 100 },
  });
  try { return await operation(); } finally { await release(); }
}

export async function writeWorkspaceJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await rename(temporary, file);
  } finally { await rm(temporary, { force: true }); }
}
