export type LandingArchiveInput = {
  version: number; workspaceName: string; workspacePath: string;
  integrationBranch: string; artifactCommitId: string;
};
/** Retain landing evidence outside the disposable checkout before it is removed. */
export function archiveIntegratedWorkspaceEvidence(gitDirectory: string, state: LandingArchiveInput): Promise<void>;
