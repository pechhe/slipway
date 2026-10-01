export const LANDED_WORKSPACE_REFUSAL: string;
export function assertWorkspaceNotRetired(workspaceName: string): Promise<void>;
export type WorkspaceContinuationDisposition =
  | { kind: "active" }
  | { kind: "resume_unfinished"; artifactCommitId: string }
  | { kind: "landed_source"; artifactCommitId: string }
  | { kind: "recovery_required"; reason: string };
export function workspaceContinuationDisposition(
  state: { phase?: string; workspaceName: string; workspacePath: string; integrationRoot?: string;
    integrationBranch: string; artifactCommitId: string; issueNumber?: number } | null,
  evidence: { workspaceName: string; workspacePath: string; integrationRoot: string; integrationBranch: string;
    issueNumber: number | null; hasUnintegratedWork: boolean; landedArtifactIntegrated: boolean },
): WorkspaceContinuationDisposition;
export function cleanupRetentionReason(
  state: { phase?: string; workspaceName: string; workspacePath: string; integrationRoot?: string;
    integrationBranch: string; workspaceImplementationChangeId?: string; artifactChangeId?: string; artifactCommitId: string;
    issueNumber?: number; recoveryNeeded?: boolean; cleanupPending?: boolean; landedAt?: string; cleanupEligibleAt?: string } | null,
  context: { current: { name: string; root: string }; integration: { root: string }; integrationBranch: string },
  metadata: Record<string, unknown> | null,
): string | null;
