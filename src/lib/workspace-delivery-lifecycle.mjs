import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
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
  const minimum = cleanupEligibleAt(state.landedAt);
  const due = state.cleanupEligibleAt ?? minimum;
  if (!minimum || !Number.isFinite(Date.parse(due)) || Date.parse(due) < Date.parse(minimum)) return "invalid-cleanup-eligibility";
  if (now < Date.parse(due)) return "grace-period";
  return null;
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
