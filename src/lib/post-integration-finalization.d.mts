export type PostIntegrationResult = {
  ok: boolean;
  sourceIntegrated: true;
  status: "not_declared" | "approval_required" | "running" | "failed" | "complete" | "covered";
  integratedCommitSha: string;
  policyDigest?: string;
  target?: string;
  idempotencyKey?: string;
  attempt?: number;
  approved?: true;
  authorization?: "human" | "repository-policy";
  coverage?: "descendant";
  coveredByCommitSha?: string;
  coveredByPolicyDigest?: string;
  priorFailure?: { attempt: number; reason: string };
  reason?: string;
};

export type PostIntegrationInput = {
  gitDirectory: string;
  integratedCommitSha: string;
  readIntegrationTip: () => Promise<string>;
  approval?: unknown;
  inspectOnly?: boolean;
  abortSignal?: AbortSignal;
  recoverDescendant?: boolean;
  /** Internal test/storage seam, never accepted from delivery tool input. */
  stateDirectory?: string;
  environment?: () => NodeJS.ProcessEnv;
};

export function finalizePostIntegration(input: PostIntegrationInput): Promise<PostIntegrationResult>;
