import type { LandingAdapter, LandingRevision, WorkspaceContext } from "./peach-workspace.mjs";
import type { VerificationEvidence } from "./verification-policy.mjs";

export type CandidateContext = {
  current: { name: string; root: string };
  integration: { name: string; root: string };
  integrationBranch: string;
};
export type CandidateOptions = {
  adapter?: LandingAdapter;
  localOnly?: boolean;
  operationId?: string;
  onProgress?: (line: string) => void;
  onStage?: (stage: "rebasing" | "verifying" | "integrating" | "cleaning") => void;
};
export type LandingIO = {
  landingPreview(cwd: string): Promise<{ context: CandidateContext; target: LandingRevision }>;
  ensureLandingDescription(cwd: string, context: CandidateContext, target: LandingRevision): Promise<LandingRevision>;
  assertDefaultReady(context: CandidateContext): Promise<unknown>;
  assertStackConflictFree(cwd: string, branch: string, changeId: string): Promise<unknown>;
  jj(cwd: string, args: string[]): Promise<string>;
  revisionFacts(cwd: string, revision: string): Promise<LandingRevision>;
  runVerification(context: CandidateContext, progress?: (line: string) => void): Promise<VerificationEvidence>;
  writeLandingState(context: CandidateContext, artifact: LandingRevision, verification: VerificationEvidence, phase: string, localOnly?: boolean, operationId?: string): Promise<unknown>;
  readJsonOptional(path: string): Promise<Record<string, unknown>>;
  statePath(name: string): string;
};
export function integrateLandingCandidate(cwd: string, options: CandidateOptions, io: LandingIO): Promise<{ context: CandidateContext; artifact: LandingRevision; verification: VerificationEvidence; cleanupPending: boolean; cleanupError?: string }>;
export function finishLanding(context: WorkspaceContext, state: Record<string, unknown>, options: CandidateOptions, io: LandingIO): Promise<{ cleanupPending: boolean; cleanupError?: string }>;
