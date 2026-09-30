/** One shared landing candidate transition, used by both native Pi and the host. */
import { resolve } from "node:path";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.mjs";

export async function integrateLandingCandidate(cwd, options, io) {
  const { landingPreview, ensureLandingDescription, assertDefaultReady, jj, assertStackConflictFree, revisionFacts, runVerification, writeLandingState, readJsonOptional, statePath } = io;
  const adapter = options.adapter ?? {};
  const preview = await (adapter.preview?.() ?? landingPreview(cwd));
  const { context } = preview;
  const direct = context.current.name === "default";
  let target = await ensureLandingDescription(cwd, context, preview.target);
  if (adapter.repairTarget) target = await adapter.repairTarget(target);
  if (!direct) await assertDefaultReady(context);
  // The machine-wide slot protects generation and verification. The repository
  // transaction covers only the final identity check and bookmark transition.
  {
    options.onStage?.("rebasing");
    await jj(cwd, ["rebase", "--branch", target.changeId, "--onto", context.integrationBranch]);
    await assertStackConflictFree(cwd, context.integrationBranch, target.changeId);
    const base = await revisionFacts(cwd, context.integrationBranch);
    let candidate = await revisionFacts(cwd, target.changeId);
    if (adapter.finalizeCandidate) candidate = await adapter.finalizeCandidate(candidate, base);
    const assertIdentity = async () => {
      const drift = await jj(cwd, ["diff", "--from", candidate.commitId, "--to", "@", "--summary"]);
      if ((await revisionFacts(cwd, target.changeId)).commitId !== candidate.commitId || drift)
        throw new Error("Verification checkout differs from the landing candidate; repair and rerun landing");
      if ((await revisionFacts(cwd, context.integrationBranch)).commitId !== base.commitId)
        throw new Error("Integration bookmark moved during verification; rerun landing against the new base");
    };
    await assertIdentity();
    options.onStage?.("verifying");
    const verification = await (adapter.verify?.({ base: base.commitId, candidate: candidate.commitId }) ?? runVerification(context, options.onProgress));
    await assertIdentity();
    if (!direct) await assertDefaultReady(context);
    await withWorkspaceTransaction(`integrate:${resolve(context.integration.root)}:${context.integrationBranch}`, async () => {
      await assertIdentity();
      if (!direct) await assertDefaultReady(context);
      if (!direct) await writeLandingState(context, candidate, verification, "prepared", options.localOnly, options.operationId);
      options.onStage?.("integrating");
      await jj(cwd, ["bookmark", "set", context.integrationBranch, "--revision", candidate.commitId]);
      if (!direct) await writeLandingState(context, candidate, verification, "landed", options.localOnly, options.operationId);
    });
    options.onStage?.("cleaning");
    const state = direct ? { artifactCommitId: candidate.commitId } : await readJsonOptional(statePath(context.current.name));
    const cleanup = await finishLanding(context, state, options, io);
    return { context, artifact: candidate, base: base.commitId, verification, ...cleanup };
  }
}

export async function finishLanding(context, state, options, io) {
  const { revisionFacts, jj, statePath } = io;
  if (options.adapter?.finish) return options.adapter.finish(context, state);
  try {
    const currentDefault = await revisionFacts(context.integration.root, "@");
    if (currentDefault.empty || (context.current.name === "default" && currentDefault.commitId === state.artifactCommitId)) {
      await jj(context.integration.root, ["new", context.integrationBranch]);
    } else throw new Error("Canonical checkout has unintegrated changes; preserving both workspaces");
    const current = await revisionFacts(context.current.root, "@");
    if (!current.empty && current.commitId === state.artifactCommitId) await jj(context.current.root, ["new", context.integrationBranch]);
    state.cleanupPending = false;
    delete state.cleanupError;
  } catch (error) {
    state.cleanupPending = true;
    state.cleanupError = error instanceof Error ? error.message : String(error);
  }
  if (context.current.name !== "default") await writeWorkspaceJson(statePath(context.current.name), state);
  return { cleanupPending: state.cleanupPending, ...(state.cleanupError ? { cleanupError: state.cleanupError } : {}) };
}

