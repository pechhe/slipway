import assert from "node:assert/strict";
import { test } from "vite-plus/test";
import { landingTimingLine } from "../src/lib/landing-timing.mjs";

test("landing timing reports each stage, finalization coverage and the total", () => {
  const line = landingTimingLine({ startedAt: 0, finishedAt: 9_000, stages: [["preparing", 0], ["verifying", 1_000], ["cleaning", 5_000]] }, {
    postIntegration: { ok: true, status: "covered", coveredByCommitSha: "abcdef1234" },
    timings: { finalizingStartedAt: 5_500, publishingStartedAt: 5_700, finishedAt: 8_000 },
  });
  assert.equal(line, "[land] preparing 1.0s · verifying 4.0s · cleaning 0.5s · finalizing 0.2s (covered by abcdef1) · publishing 2.3s · total 9.0s");
});

test("landing timing omits publication after a blocked finalization", () => {
  const line = landingTimingLine({ startedAt: 0, finishedAt: 2_000, stages: [["preparing", 0]] }, {
    postIntegration: { ok: false, status: "failed" },
    timings: { finalizingStartedAt: 1_000, publishingStartedAt: 1_500, finishedAt: 1_500 },
  });
  assert.equal(line, "[land] preparing 1.0s · finalizing 0.5s (failed) · total 2.0s");
});
