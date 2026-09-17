import type { PostIntegrationApproval } from "./post-integration-policy.mjs";
import type { PostIntegrationResult } from "./post-integration-finalization.mjs";
export function finalizeIntegratedWorkspace(cwd: string, options: {
  expectedCommitSha: string; approval?: PostIntegrationApproval; inspectOnly?: boolean; abortSignal?: AbortSignal;
}): Promise<PostIntegrationResult>;
