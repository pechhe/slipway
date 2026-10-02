import type { VerificationDeclaration } from "./verification-policy.mjs";

export type ReleasePlan = {
  root: string;
  integrationRoot: string;
  remote: string;
  integrationBranch: string;
  releaseBranch: string;
  /** The release branch on the remote. */
  base: string;
  /** The integration commit being released. */
  candidate: string;
  commits: Array<{ commitId: string; subject: string }>;
  migrationArtifacts: string[];
  checks: VerificationDeclaration[];
};

export type ReleaseSummary = {
  integrationBranch: string;
  releaseBranch: string;
  remote: string;
  base: string;
  candidate: string;
  commits: number;
  migrationArtifacts: string[];
  checks: string[];
};

export type ReleaseResult =
  | ({ ok: true; status: "up_to_date" } & ReleaseSummary)
  | ({ ok: true; status: "planned"; subjects: string[]; next: string } & ReleaseSummary)
  | ({ ok: true; status: "released"; merge: string; verification: unknown; releasedAt: string } & ReleaseSummary)
  | { ok: false; status: "refused"; reason: string }
  | { ok: false; status: "verification_failed"; reason: string; evidence: unknown };

export function planRelease(cwd?: string, options?: { candidate?: string }): Promise<ReleasePlan>;
export function releaseIntegration(
  cwd?: string,
  options?: { confirm?: string; migrationsReady?: boolean; onProgress?: (line: string) => void },
): Promise<ReleaseResult>;
