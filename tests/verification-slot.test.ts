import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import {
  VERIFICATION_SLOT_ENV,
  verificationSlotEnvironment,
  withVerificationSlot,
} from "../src/lib/verification-slot.mjs";

test("landing verifications on one machine run one at a time, in arrival order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "verification-slot-"));
  const env = { ...process.env, [VERIFICATION_SLOT_ENV]: undefined };
  try {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let waited = false;
    const first = withVerificationSlot(async () => {
      events.push("first:start");
      await firstHeld;
      events.push("first:end");
    }, { root, env, pollMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const second = withVerificationSlot(async () => { events.push("second:start"); }, {
      root, env, pollMs: 10, onWait: () => { waited = true; },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.deepEqual(events, ["first:start"]);
    assert.equal(waited, true);
    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a landing started inside a held slot does not wait for its parent", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "verification-slot-nested-"));
  const env = { ...process.env, [VERIFICATION_SLOT_ENV]: undefined };
  try {
    const nested = await withVerificationSlot(
      () => withVerificationSlot(async () => "nested ran", { root, env: verificationSlotEnvironment(env), pollMs: 10 }),
      { root, env, pollMs: 10 },
    );
    assert.equal(nested, "nested ran");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
