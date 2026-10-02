import type { RevisionFacts, WorkspaceContext } from "./workspace-jj.mjs";
/** Result of the push step that ends every landing. */
export interface LandingPublication {
  ok: boolean;
  status: "pushed" | "push_failed" | "local_only" | "not_declared" | "blocked";
  commitId: string;
  remote?: string;
  branch?: string;
  reason?: string;
}
export type LandingTailOptions = {
  localOnly?: boolean;
  /** Human approval for an `explicit-human` post-integration step; see post-integration-policy. */
  postIntegrationApproval?: unknown;
  environment?: () => NodeJS.ProcessEnv;
};
export type LandingTail = {
  ok: boolean;
  postIntegration: import("./post-integration-finalization.mjs").PostIntegrationResult;
  publication: LandingPublication;
  /** Wall-clock (epoch ms) starts of post-integration finalization and publication, for timing output only. */
  timings?: { finalizingStartedAt: number; publishingStartedAt: number; finishedAt: number };
};
/** True when the landed artifact is on the declared remote, or no publication applies. */
export function artifactPublished(cwd: string, context: { integrationBranch: string; configuration: { remote?: string | null } }, state: { artifactCommitId: string; localOnly?: boolean }): Promise<boolean>;
/** Declared post-integration step, then push, after the integration bookmark moved. */
export function completeLanding(cwd: string, context: { integrationBranch: string; configuration: { remote?: string | null } }, commitId: string, options?: LandingTailOptions): Promise<LandingTail>;
export type LandingRevision = { commitId: string; changeId: string; empty: boolean; conflict: boolean; description: string };
/** Internal host seams, not accepted from tool input. They do not own landing order. */
export type LandingAdapter = {
  preview?: () => Promise<{ context: { current: { name: string; root: string }; integration: { name: string; root: string }; integrationBranch: string; configuration: { requiredLocalVerification: unknown[]; remote?: string | null } }; target: LandingRevision }>;
  repairTarget?: (target: LandingRevision) => Promise<LandingRevision>;
  finalizeCandidate?: (candidate: LandingRevision, base: LandingRevision) => Promise<LandingRevision>;
  verify?: (identity: { base: string; candidate: string }) => Promise<import("./verification-policy.mjs").VerificationEvidence>;
};
export function landingPreview(cwd?: string, options?: { allowDefaultWorkspace?: boolean }): Promise<{
  context: WorkspaceContext;
  targetRevision: string;
  target: RevisionFacts;
  stat: string;
}>;
export function finishLandedWorkspace(context: WorkspaceContext, state: Record<string, unknown>): Promise<Record<string, unknown>>;
/** The remote this landing publishes to, or null for local-only/undeclared delivery. */
export function publicationRemote(context: { configuration: { remote?: string | null } }, localOnly?: boolean): string | null;
export function fetchIntegration(cwd: string, remote: string, branch: string): ReturnType<typeof import("./workspace-command.mjs").runWorkspaceCommand>;
/** The verification-slot options of one landing, reporting its place in the queue. */
export function waitForLandingSlot(context: WorkspaceContext, onProgress?: (line: string) => void): {
  scope: string; label: string; onWait: (wait: { ahead: number; holder?: string | null }) => void;
};
/** What the landing candidate (landing-candidate.mjs) needs from the land command. */
export const landingIO: import("./landing-candidate.mjs").LandingIO;
