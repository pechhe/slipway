import type { PostIntegrationApproval } from "./post-integration-policy.mjs";
import type { PostIntegrationResult } from "./post-integration-finalization.mjs";
import type { SourcePublicationResult } from "./source-publication.mjs";
export type WorkspaceFinalizationResult = {
  ok: boolean;
  sourceIntegrated: true;
  endpoint: "local_integration" | "git_remote";
  integratedCommitSha: string;
  postIntegration: PostIntegrationResult;
  sourcePublication: SourcePublicationResult;
  reason?: string;
};
export function finalizeIntegratedWorkspace(cwd: string, options: {
  expectedCommitSha: string; approval?: PostIntegrationApproval; localOnly?: boolean; inspectOnly?: boolean; abortSignal?: AbortSignal;
}): Promise<WorkspaceFinalizationResult>;

export type IntegratedWorkspaceEvidence = {
  context: import("./peach-workspace.mjs").WorkspaceContext;
  gitDirectory: string;
  state: {
    version: number; phase: "landed"; workspaceName: string; workspacePath: string;
    integrationRoot: string; integrationBranch: string; artifactCommitId: string;
    artifactChangeId: string; artifactDescription: string; verification: "passed" | "passed_with_gaps";
    issueNumber?: number; localOnly?: boolean;
    [key: string]: unknown;
  };
};
export function readIntegratedWorkspaceEvidence(cwd: string, expected: string): Promise<IntegratedWorkspaceEvidence | null>;
export type LandingArchiveInput = {
  version: number; workspaceName: string; workspacePath: string;
  integrationBranch: string; artifactCommitId: string;
};
export function archiveIntegratedWorkspaceEvidence(gitDirectory: string, state: LandingArchiveInput): Promise<void>;
