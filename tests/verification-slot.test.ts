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

test("a waiting landing reports how many landings are ahead and who holds the slot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "verification-slot-ahead-"));
  const env = { ...process.env, [VERIFICATION_SLOT_ENV]: undefined };
  const until = async (condition: () => boolean) => {
    while (!condition()) await new Promise((resolve) => setTimeout(resolve, 5));
  };
  try {
    let releaseHolder!: () => void;
    const holderHeld = new Promise<void>((resolve) => { releaseHolder = resolve; });
    let holding = false;
    const holder = withVerificationSlot(async () => { holding = true; await holderHeld; }, { root, env, pollMs: 10, label: "jj:holder" });
    await until(() => holding);
    const firstStatuses: Array<{ ahead: number; holder: string | null }> = [];
    const secondStatuses: Array<{ ahead: number; holder: string | null }> = [];
    const first = withVerificationSlot(async () => {}, { root, env, pollMs: 10, label: "jj:first", onWait: (status) => firstStatuses.push(status) });
    await until(() => firstStatuses.length > 0);
    const second = withVerificationSlot(async () => {}, { root, env, pollMs: 10, label: "jj:second", onWait: (status) => secondStatuses.push(status) });
    await until(() => secondStatuses.length > 0);
    assert.deepEqual(firstStatuses[0], { ahead: 1, holder: "jj:holder" });
    assert.deepEqual(secondStatuses[0], { ahead: 2, holder: "jj:holder" });
    releaseHolder();
    await Promise.all([holder, first, second]);
    // The slot is not first-come-first-served, so only the count shrinking is guaranteed.
    assert.ok(secondStatuses.every((status, index) => index === 0 || status.ahead <= secondStatuses[index - 1]!.ahead));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
