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

test("a landing holding the slot runs its own verification without re-queueing, while others still wait", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "verification-slot-reentrant-"));
  const env = { ...process.env, [VERIFICATION_SLOT_ENV]: undefined };
  try {
    const events: string[] = [];
    let releaseLanding!: () => void;
    const landingHeld = new Promise<void>((resolve) => { releaseLanding = resolve; });
    let innerVerified!: () => void;
    const verified = new Promise<void>((resolve) => { innerVerified = resolve; });
    const landing = withVerificationSlot(async () => {
      events.push("landing:rebase");
      await withVerificationSlot(async () => { events.push("landing:verify"); }, { root, env, pollMs: 10 });
      innerVerified();
      await landingHeld;
      events.push("landing:integrate");
    }, { root, env, pollMs: 10 });
    await verified;
    let waited = false;
    const other = withVerificationSlot(async () => { events.push("other:rebase"); }, {
      root, env, pollMs: 10, onWait: () => { waited = true; },
    });
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.equal(waited, true);
    releaseLanding();
    await Promise.all([landing, other]);
    assert.deepEqual(events, ["landing:rebase", "landing:verify", "landing:integrate", "other:rebase"]);
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
