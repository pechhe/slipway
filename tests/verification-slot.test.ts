import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import {
  VERIFICATION_SLOT_ENV,
  verificationSlotEnvironment,
  withVerificationSlot,
} from "../src/lib/verification-slot.mjs";

type WaitStatus = { ahead: number; holder: string | null };

function signal<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => { resolve = settle; });
  return { promise, resolve };
}

/**
 * Runs a scenario against a private slot root. Held operations are released and
 * every started landing settles before the root is removed, so a failing
 * assertion cannot leave a landing writing into a deleted fixture.
 */
async function withSlotFixture(
  name: string,
  scenario: (fixture: {
    root: string;
    env: NodeJS.ProcessEnv;
    track: <T>(landing: Promise<T>) => Promise<T>;
    hold: () => { promise: Promise<void>; resolve: () => void };
  }) => Promise<void>,
) {
  const root = await mkdtemp(path.join(tmpdir(), `verification-slot-${name}-`));
  const env = { ...process.env, [VERIFICATION_SLOT_ENV]: undefined };
  const landings: Promise<unknown>[] = [];
  const holds: Array<() => void> = [];
  try {
    await scenario({
      root,
      env,
      track: (landing) => { landings.push(landing); return landing; },
      hold: () => { const held = signal(); holds.push(held.resolve); return held; },
    });
  } finally {
    for (const release of holds) release();
    await Promise.allSettled(landings);
    await rm(root, { recursive: true, force: true });
  }
}

test("landing verifications on one machine run one at a time, in arrival order", () =>
  withSlotFixture("order", async ({ root, env, track, hold }) => {
    const events: string[] = [];
    const firstHeld = hold();
    const firstStarted = signal();
    const secondWaiting = signal<WaitStatus>();
    const first = track(withVerificationSlot(async () => {
      events.push("first:start");
      firstStarted.resolve();
      await firstHeld.promise;
      events.push("first:end");
    }, { root, env, pollMs: 10 }));
    await firstStarted.promise;
    const second = track(withVerificationSlot(async () => { events.push("second:start"); }, {
      root, env, pollMs: 10, onWait: secondWaiting.resolve,
    }));
    await secondWaiting.promise;
    assert.deepEqual(events, ["first:start"]);
    firstHeld.resolve();
    await Promise.all([first, second]);
    assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
  }));

test("a landing holding the slot runs its own verification without re-queueing, while others still wait", () =>
  withSlotFixture("reentrant", async ({ root, env, track, hold }) => {
    const events: string[] = [];
    const landingHeld = hold();
    const verified = signal();
    const otherWaiting = signal<WaitStatus>();
    const landing = track(withVerificationSlot(async () => {
      events.push("landing:rebase");
      await withVerificationSlot(async () => { events.push("landing:verify"); }, { root, env, pollMs: 10 });
      verified.resolve();
      await landingHeld.promise;
      events.push("landing:integrate");
    }, { root, env, pollMs: 10 }));
    await verified.promise;
    const other = track(withVerificationSlot(async () => { events.push("other:rebase"); }, {
      root, env, pollMs: 10, onWait: otherWaiting.resolve,
    }));
    await otherWaiting.promise;
    landingHeld.resolve();
    await Promise.all([landing, other]);
    assert.deepEqual(events, ["landing:rebase", "landing:verify", "landing:integrate", "other:rebase"]);
  }));

test("a landing started inside a held slot does not wait for its parent", () =>
  withSlotFixture("nested", async ({ root, env }) => {
    const nested = await withVerificationSlot(
      () => withVerificationSlot(async () => "nested ran", { root, env: verificationSlotEnvironment(env), pollMs: 10 }),
      { root, env, pollMs: 10 },
    );
    assert.equal(nested, "nested ran");
  }));

test("a waiting landing reports how many landings are ahead and who holds the slot", () =>
  withSlotFixture("ahead", async ({ root, env, track, hold }) => {
    const holderHeld = hold();
    const holding = signal();
    const firstWaiting = signal();
    const secondWaiting = signal();
    const firstStatuses: WaitStatus[] = [];
    const secondStatuses: WaitStatus[] = [];
    const holder = track(withVerificationSlot(async () => { holding.resolve(); await holderHeld.promise; }, {
      root, env, pollMs: 10, label: "jj:holder",
    }));
    await holding.promise;
    const first = track(withVerificationSlot(async () => {}, {
      root, env, pollMs: 10, label: "jj:first",
      onWait: (status) => { firstStatuses.push(status); firstWaiting.resolve(); },
    }));
    await firstWaiting.promise;
    const second = track(withVerificationSlot(async () => {}, {
      root, env, pollMs: 10, label: "jj:second",
      onWait: (status) => { secondStatuses.push(status); secondWaiting.resolve(); },
    }));
    await secondWaiting.promise;
    assert.deepEqual(firstStatuses[0], { ahead: 1, holder: "jj:holder" });
    assert.deepEqual(secondStatuses[0], { ahead: 2, holder: "jj:holder" });
    holderHeld.resolve();
    await Promise.all([holder, first, second]);
    // The slot is not first-come-first-served, so only the count shrinking is guaranteed.
    assert.ok(secondStatuses.every((status, index) => index === 0 || status.ahead <= secondStatuses[index - 1]!.ahead));
  }));

test("landings of different integration roots hold separate slots and run concurrently", () =>
  withSlotFixture("scope", async ({ root, env, track, hold }) => {
    const events: string[] = [];
    const firstHeld = hold();
    const firstStarted = signal();
    const first = track(withVerificationSlot(async () => {
      events.push("repo-a:start");
      firstStarted.resolve();
      await firstHeld.promise;
      events.push("repo-a:end");
    }, { root, env, pollMs: 10, scope: "/repos/a" }));
    await firstStarted.promise;
    await track(withVerificationSlot(async () => { events.push("repo-b:start"); }, {
      root, env, pollMs: 10, scope: "/repos/b",
      onWait: () => assert.fail("a landing in another repository must not wait"),
    }));
    assert.deepEqual(events, ["repo-a:start", "repo-b:start"]);
    const sameRepoWaiting = signal<WaitStatus>();
    const sameRepo = track(withVerificationSlot(async () => { events.push("repo-a:second"); }, {
      root, env, pollMs: 10, scope: "/repos/a", onWait: sameRepoWaiting.resolve,
    }));
    assert.deepEqual(await sameRepoWaiting.promise, { ahead: 1, holder: null });
    firstHeld.resolve();
    await Promise.all([first, sameRepo]);
    assert.deepEqual(events, ["repo-a:start", "repo-b:start", "repo-a:end", "repo-a:second"]);
  }));

test("a waiting record left by a dead landing is purged and never counted as ahead", () =>
  withSlotFixture("dead", async ({ root, env, track, hold }) => {
    const holderHeld = hold();
    const holding = signal();
    const holder = track(withVerificationSlot(async () => { holding.resolve(); await holderHeld.promise; }, {
      root, env, pollMs: 10, scope: "/repos/a", label: "jj:holder",
    }));
    await holding.promise;
    const holderFile = (await readdir(root)).find((name) => name.endsWith(".holder.json"))!;
    const waitingDir = path.join(root, `${holderFile.replace(/\.holder\.json$/, "")}.waiting`);
    await mkdir(waitingDir, { recursive: true });
    await writeFile(path.join(waitingDir, "dead.json"), JSON.stringify({ id: "dead", pid: 2 ** 22 - 1, since: 0, label: "jj:dead" }));
    const waiting = signal<WaitStatus>();
    const waiter = track(withVerificationSlot(async () => {}, {
      root, env, pollMs: 10, scope: "/repos/a", label: "jj:live", onWait: waiting.resolve,
    }));
    assert.deepEqual(await waiting.promise, { ahead: 1, holder: "jj:holder" });
    assert.ok(!(await readdir(waitingDir)).includes("dead.json"), "dead record is removed");
    holderHeld.resolve();
    await Promise.all([holder, waiter]);
  }));
