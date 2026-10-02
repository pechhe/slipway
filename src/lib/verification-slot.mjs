import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { stateHome } from "./workspace-paths.mjs";

/** Set on verification commands so a landing started inside one (a test
 * fixture, a nested tool) never waits for the slot its parent holds. */
export const VERIFICATION_SLOT_ENV = "PEACH_VERIFICATION_SLOT";

/** Environment for a command running inside the held slot. */
export function verificationSlotEnvironment(environment = process.env) {
  return { ...environment, [VERIFICATION_SLOT_ENV]: "held" };
}

// Marks the async flow that holds the slot, so a landing can hold it across
// rebase, verification and integration while its inner verification call
// passes straight through.
const heldSlot = new AsyncLocalStorage();

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};

// A record whose process is gone is removed, so a crashed landing never counts
// as ahead of a live one and the waiting directory cannot grow without bound.
const readRecord = async (file) => {
  let record;
  try { record = JSON.parse(await readFile(file, "utf8")); } catch { return null; }
  if (Number.isInteger(record?.pid) && alive(record.pid)) return record;
  await rm(file, { force: true }).catch(() => {});
  return null;
};

/** One slot per integration root, so unrelated repositories never queue on each other. */
const slotName = (scope) => scope
  ? `verification-slot-${createHash("sha256").update(String(scope)).digest("hex").slice(0, 16)}`
  : "verification-slot";

/**
 * Who is ahead of a waiting landing: the holder plus live landings that started
 * waiting earlier. Advisory only: the slot is not first-come-first-served, and
 * these records only describe it.
 */
async function slotQueueStatus(target, waitingDir, own) {
  const holder = await readRecord(`${target}.holder.json`);
  const names = await readdir(waitingDir).catch(() => []);
  const waiters = await Promise.all(names.filter((name) => name !== `${own.id}.json`)
    .map((name) => readRecord(join(waitingDir, name))));
  const earlier = waiters.filter((record) => record && (record.since < own.since || (record.since === own.since && record.id < own.id)));
  return { ahead: earlier.length + 1, holder: holder?.label ?? null };
}

/**
 * Run one landing while holding the verification slot for its integration root
 * (`scope`), so concurrent landings of one repository queue instead of starving
 * each other's timeouts while unrelated repositories land in parallel. A
 * landing holds it from rebase through integration: verifying against a base
 * that another landing advances meanwhile only earns a "bookmark moved" retry.
 * The lock lives under the user's Pi home and goes stale a minute after its
 * holder dies. Without a `scope` the slot is machine-wide. `onWait` is called
 * when the landing starts waiting and whenever the number of landings ahead of
 * it (or the holder) changes.
 */
export async function withVerificationSlot(operation, options = {}) {
  const environment = options.env ?? process.env;
  if (environment[VERIFICATION_SLOT_ENV] === "held" || heldSlot.getStore()) return await operation();
  const root = options.root ?? stateHome();
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, slotName(options.scope));
  const waitingDir = `${target}.waiting`;
  const own = { id: randomUUID(), pid: process.pid, since: Date.now(), label: options.label ?? null };
  const pollMs = options.pollMs ?? 2_000;
  let release = null;
  let waiting = false;
  let reported = "";
  try {
    while (!release) {
      options.signal?.throwIfAborted();
      try {
        release = await lockfile.lock(target, {
          realpath: false, stale: 60_000, update: 15_000, retries: 0,
          // A lost slot only weakens queueing; it must never crash the landing process.
          onCompromised: () => {},
        });
      } catch (error) {
        if (error?.code !== "ELOCKED") throw error;
        if (!waiting) {
          waiting = true;
          await mkdir(waitingDir, { recursive: true, mode: 0o700 });
          await writeFile(join(waitingDir, `${own.id}.json`), JSON.stringify(own), { mode: 0o600 });
        }
        const status = await slotQueueStatus(target, waitingDir, own);
        if (JSON.stringify(status) !== reported) {
          reported = JSON.stringify(status);
          options.onWait?.(status);
        }
        await sleep(pollMs, undefined, options.signal ? { signal: options.signal } : undefined);
      }
    }
  } finally {
    if (waiting) await rm(join(waitingDir, `${own.id}.json`), { force: true }).catch(() => {});
  }
  const holderFile = `${target}.holder.json`;
  await writeFile(holderFile, JSON.stringify(own), { mode: 0o600 }).catch(() => {});
  try {
    return await heldSlot.run(true, operation);
  } finally {
    // Only the current holder clears its record; a compromised slot may have moved on.
    if ((await readRecord(holderFile))?.id === own.id) await rm(holderFile, { force: true }).catch(() => {});
    await release().catch(() => {});
  }
}
