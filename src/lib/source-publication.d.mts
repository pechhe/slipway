type Environment = () => NodeJS.ProcessEnv;

export type SourcePublicationResult = {
  ok: boolean;
  sourceIntegrated: true;
  status: "not_declared" | "pending" | "running" | "failed" | "complete" | "local_only";
  integratedCommitSha: string;
  integrationBranch: string;
  remote?: string;
  policyDigest?: string;
  idempotencyKey?: string;
  targetCommitSha?: string;
  observedRemoteSha?: string;
  coverage?: "exact" | "descendant";
  attempt?: number;
  reason?: string;
  code?: string;
  version?: 1;
  localOnly?: boolean;
  destinationDigest?: string;
  outgoingCount?: number;
  outgoingDigest?: string;
  remoteBeforeSha?: string;
};

export type SourcePublicationInput = {
  gitDirectory: string;
  integratedCommitSha: string;
  integrationBranch: string;
  readIntegrationTip: () => Promise<string>;
  localOnly?: boolean;
  inspectOnly?: boolean;
  abortSignal?: AbortSignal;
  stateDirectory?: string;
  environment?: Environment;
};

export function finalizeSourcePublication(input: SourcePublicationInput): Promise<SourcePublicationResult>;
