import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
/** Durable retirement policy shared by Peach and vanilla Pi. Time is only a
 * prerequisite; callers must prove identity, ancestry and exclusive access. */
export const WORKSPACE_CLEANUP_GRACE_MS = 24 * 60 * 60 * 1000;

export function cleanupEligibleAt(landedAt) {
  const time = Date.parse(landedAt);
  return Number.isFinite(time) ? new Date(time + WORKSPACE_CLEANUP_GRACE_MS).toISOString() : null;
}

export function cleanupRetentionReason(state, context, metadata, now = Date.now()) {
  if (!state || state.phase !== "landed") return "not-landed";
  if (state.workspaceName !== context.current.name
    || state.workspacePath !== context.current.root
    || state.integrationRoot !== context.integration.root
    || state.integrationBranch !== context.integrationBranch
    || !state.artifactChangeId
    || !/^[a-f0-9]{40,64}$/i.test(state.artifactCommitId ?? "")
    || (state.issueNumber ?? null) !== (metadata?.issueNumber ?? null)
    || (state.issueNumber && metadata?.implementationChangeId && metadata.implementationChangeId !== (state.workspaceImplementationChangeId ?? state.artifactChangeId))) return "identity-mismatch";
  if (state.recoveryNeeded || state.cleanupPending) return "recovery-needed";
  if (metadata?.reopenedFromArtifactCommitId === state.artifactCommitId) return "reopened";
  const minimum = cleanupEligibleAt(state.landedAt);
  const due = state.cleanupEligibleAt ?? minimum;
  if (!minimum || !Number.isFinite(Date.parse(due)) || Date.parse(due) < Date.parse(minimum)) return "invalid-cleanup-eligibility";
  if (now < Date.parse(due)) return "grace-period";
  return null;
}

/**
 * Decide whether a historical landing still retires this workspace. A prior
 * receipt remains immutable history. New source may continue only when the
 * same workspace and Issue still own it, the exact landed artifact remains
 * integrated, and later unintegrated source is now present, or the owner has
 * explicitly reopened this exact landed artifact for same-task follow-up.
 * Writer ownership remains a separate authority check.
 */
export function workspaceContinuationDisposition(state, evidence) {
  if (!state || state.phase !== "landed") return { kind: "active" };
  const identityMatches = state.workspaceName === evidence.workspaceName
    && resolve(state.workspacePath) === resolve(evidence.workspacePath)
    && Boolean(state.integrationRoot)
    && resolve(state.integrationRoot) === resolve(evidence.integrationRoot)
    && state.integrationBranch === evidence.integrationBranch
    && (state.issueNumber ?? null) === (evidence.issueNumber ?? null)
    && /^[a-f0-9]{40,64}$/i.test(state.artifactCommitId ?? "");
  if (!identityMatches) {
    return { kind: "recovery_required", reason: "historical-landing-identity-mismatch" };
  }
  if (!evidence.landedArtifactIntegrated) {
    return { kind: "recovery_required", reason: "historical-landed-artifact-not-integrated" };
  }
  if (evidence.hasUnintegratedWork) {
    return { kind: "resume_unfinished", artifactCommitId: state.artifactCommitId };
  }
  if (evidence.reopenedArtifactCommitId && evidence.reopenedArtifactCommitId === state.artifactCommitId) {
    return { kind: "reopened", artifactCommitId: state.artifactCommitId };
  }
  return { kind: "landed_source", artifactCommitId: state.artifactCommitId };
}

export async function assertWorkspaceNotRetired(workspaceName) {
  if (workspaceName === "default") return;
  const root = join(homedir(), ".pi", "agent", "workspace-state");
  for (const file of [join(root, workspaceName + ".json"), join(root, "landed", workspaceName + ".json")]) {
    let state;
    try { state = JSON.parse(await readFile(file, "utf8")); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (state?.workspaceName === workspaceName && state.phase === "landed") {
      throw new Error("This workspace is a completed delivery. Inspect its history read-only; continue in the next Issue's workspace.");
    }
  }
}
