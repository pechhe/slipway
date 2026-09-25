export type FinalizationCommand = { executable: string; args: string[]; cwd: string };
export type PostIntegrationPolicy = {
  version: 1;
  target: string;
  idempotency: "artifact-key";
  command: FinalizationCommand;
  targetProbe: FinalizationCommand;
  timeoutMs: number;
  environmentKeys: string[];
  approvalMode: "explicit-human" | "automatic-development";
};
export type PostIntegrationApproval = {
  humanApproved: true;
  integratedCommitSha: string;
  policyDigest: string;
  target: string;
};

export function postIntegrationPolicy(value: unknown): PostIntegrationPolicy | null;
export function postIntegrationPolicyDigest(policy: PostIntegrationPolicy): string;
export function exactPostIntegrationApproval(value: unknown, commit: string, digest: string, target: string): boolean;
