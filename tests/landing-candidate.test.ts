import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

vi.mock("../src/lib/workspace-transaction.mjs", () => ({
  withWorkspaceTransaction: async (_key: string, run: () => Promise<unknown>) => run(),
  writeWorkspaceJson: async () => {},
}));
import { integrateLandingCandidate } from "../src/lib/landing-candidate.mjs";

function fixture(direct = false) {
  const context = {
    current: { name: direct ? "default" : "task", root: "/task" },
    integration: { name: "default", root: "/repo" }, integrationBranch: "develop",
  };
  const candidate = { changeId: "change", commitId: "semantic", empty: false, conflict: false, description: "Task" };
  let liveCandidate = candidate;
  let liveBase = "base";
  const steps: string[] = [];
  const state: Record<string, unknown> = {};
  const io = {
    landingPreview: async () => ({ context, target: candidate }),
    ensureLandingDescription: async () => candidate,
    assertDefaultReady: async () => {},
    assertStackConflictFree: async () => {},
    revisionFacts: async (_cwd: string, revision: string) => revision === "develop"
      ? { ...candidate, commitId: liveBase } : liveCandidate,
    jj: async (_cwd: string, args: string[]) => {
      if (args[0] === "diff") return "";
      steps.push(args[0]!);
      return "";
    },
    writeLandingState: async (_ctx: unknown, artifact: typeof candidate, _verification: unknown, phase: string) => {
      Object.assign(state, { artifactCommitId: artifact.commitId, phase });
    },
    readJsonOptional: async () => state,
    statePath: () => "/state",
    runVerification: async () => { throw new Error("host verifier should be used"); },
  };
  const options = {
    adapter: {
      finalizeCandidate: async () => {
        steps.push("generate");
        liveCandidate = { ...candidate, commitId: "generated" };
        return liveCandidate;
      },
      verify: async (identity: { base: string; candidate: string }) => {
        steps.push("verify");
        assert.deepEqual(identity, { base: "base", candidate: "generated" });
        return { status: "passed" as const, passed: [], gaps: [], policyDigest: "policy" };
      },
      finish: async () => { steps.push("finish"); return { cleanupPending: false }; },
    },
  };
  return { io, options, steps, state, drift: () => { liveBase = "changed"; } };
}

for (const direct of [false, true]) test(`shared candidate transition preserves ${direct ? "Direct" : "isolated"} landing order`, async () => {
  const f = fixture(direct);
  const result = await integrateLandingCandidate("/task", f.options, f.io);
  assert.deepEqual(f.steps, ["rebase", "generate", "verify", "bookmark", "finish"]);
  assert.equal(result.artifact.commitId, "generated");
  assert.equal(result.cleanupPending, false);
  assert.equal(f.state.phase, direct ? undefined : "landed");
});

test("shared candidate transition refuses integration if verification moves the base", async () => {
  const f = fixture();
  const verify = f.options.adapter.verify;
  f.options.adapter.verify = async (identity) => {
    const result = await verify(identity);
    f.drift();
    return result;
  };
  await assert.rejects(integrateLandingCandidate("/task", f.options, f.io), /Integration bookmark moved/);
  assert.deepEqual(f.steps, ["rebase", "generate", "verify"]);
  assert.equal(f.state.phase, undefined);
});
