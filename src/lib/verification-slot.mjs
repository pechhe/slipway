import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import lockfile from "proper-lockfile";

/** Set on verification commands so a landing started inside one (a test
 * fixture, a nested tool) never waits for the slot its parent holds. */
export const VERIFICATION_SLOT_ENV = "PEACH_VERIFICATION_SLOT";

/** Environment for a command running inside the held slot. */
export function verificationSlotEnvironment(environment = process.env) {
  return { ...environment, [VERIFICATION_SLOT_ENV]: "held" };
}

/**
 * Run one landing's required verification while holding the machine-wide
 * verification slot, so concurrent landings queue instead of starving each
 * other's timeouts. The lock lives under the user's Pi home and goes stale
 * a minute after its holder dies.
 */
export async function withVerificationSlot(operation, options = {}) {
  const environment = options.env ?? process.env;
  if (environment[VERIFICATION_SLOT_ENV] === "held") return await operation();
  const root = options.root ?? join(homedir(), ".pi", "agent", "workspace-state");
  await mkdir(root, { recursive: true, mode: 0o700 });
  const target = join(root, "verification-slot");
  const pollMs = options.pollMs ?? 2_000;
  let release = null;
  let waiting = false;
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
        options.onWait?.();
      }
      await sleep(pollMs, undefined, options.signal ? { signal: options.signal } : undefined);
    }
  }
  try {
    return await operation();
  } finally {
    await release().catch(() => {});
  }
}
