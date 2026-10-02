import type { MigrationFinalizationPolicy } from "./execution-policy.mjs";
import type { LandingRevision } from "./landing-steps.mjs";
import type { BoundedProcessRequest, BoundedProcessResult } from "./bounded-process.mjs";

export function migrationCandidate(cwd: string, context: {
  current: { root: string }; integrationBranch: string;
  configuration: { migrationFinalization?: MigrationFinalizationPolicy | null };
}, io: {
  jj(cwd: string, args: string[]): Promise<string>;
  revisionFacts(cwd: string, revision: string): Promise<LandingRevision>;
}, options?: {
  onProgress?: (line: string) => void;
  environment?: () => NodeJS.ProcessEnv;
  runCommand?: (request: BoundedProcessRequest) => Promise<BoundedProcessResult>;
}): Promise<{
  finalize(candidate: LandingRevision, base: LandingRevision): Promise<LandingRevision>;
  rollback(): Promise<void>;
}>;
