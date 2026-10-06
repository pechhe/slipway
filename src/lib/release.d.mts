import type { GraphqlRunner, HalfBuiltSpecs } from "./release-specs.mjs";
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
  commits: Array<{ commitId: string; subject: string; description: string }>;
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
  /** Open Specs with Tickets in the range; absent when the range is empty. */
  halfBuiltSpecs?: HalfBuiltSpecs;
};

export type ReleaseResult =
  | ({ ok: true; status: "up_to_date" } & ReleaseSummary)
  | ({ ok: true; status: "planned"; subjects: string[]; next: string } & ReleaseSummary)
  | ({ ok: true; status: "released"; merge: string; verification: unknown; releasedAt: string } & ReleaseSummary)
  /**
   * The release branch already contains the candidate: a release this one waited
   * for shipped it, so it verified nothing. `merge` is the release merge that
   * first contained it and `releasedBy` that merge's candidate. Without such a
   * merge (the branch was moved outside `slipway release`), `merge` is the
   * release branch head and `releasedBy` null. The summary describes the plan
   * against that head, so `commits` is 0.
   */
  | ({ ok: true; status: "released_by"; merge: string; releasedBy: string | null } & ReleaseSummary)
  | { ok: false; status: "refused"; reason: string }
  | { ok: false; status: "verification_failed"; reason: string; evidence: unknown };

export function planRelease(cwd?: string, options?: { candidate?: string }): Promise<ReleasePlan>;
export function releaseIntegration(
  cwd?: string,
  options?: { confirm?: string; migrationsReady?: boolean; onProgress?: (line: string) => void; graphql?: GraphqlRunner },
): Promise<ReleaseResult>;
