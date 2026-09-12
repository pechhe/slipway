export const WORKSPACE_CLEANUP_GRACE_MS: number;
export function cleanupEligibleAt(landedAt: string): string | null;
export function assertWorkspaceNotRetired(workspaceName: string): Promise<void>;
export function cleanupRetentionReason(
  state: { phase?: string; workspaceName: string; workspacePath: string; integrationRoot?: string;
    integrationBranch: string; workspaceImplementationChangeId?: string; artifactChangeId?: string; artifactCommitId: string;
    issueNumber?: number; recoveryNeeded?: boolean; cleanupPending?: boolean; landedAt?: string; cleanupEligibleAt?: string } | null,
  context: { current: { name: string; root: string }; integration: { root: string }; integrationBranch: string },
  metadata: Record<string, unknown> | null, now?: number,
): string | null;
