export interface WorkspaceMetadata {
  issueNumber?: number;
  [key: string]: unknown;
}
export interface WorkspaceEntry {
  name: string;
  root: string;
  changeId: string;
  commitId: string;
  hasWork: boolean;
  metadata?: WorkspaceMetadata | null;
}
export interface WorkspaceContext {
  current: WorkspaceEntry;
  integration: WorkspaceEntry;
  integrationBranch: string;
  /** The policy committed on the integration bookmark (D3), or the undeclared defaults. */
  configuration: Partial<import("./execution-policy.mjs").ExecutionPolicy> & typeof import("./execution-policy.mjs").UNDECLARED_POLICY;
}
export class CommandError extends Error {}
export function explicitIssueNumber(value?: string | null): number | null;
export function readWorkspaceMode(): Promise<"isolated" | "direct">;
export function writeWorkspaceMode(mode: "isolated" | "direct"): Promise<"isolated" | "direct">;
export function workspaceContext(cwd?: string, integratedBranch?: string): Promise<WorkspaceContext | null>;
export function jjWorkspaceRoot(cwd: string): Promise<string | null>;
export function inspectWorkspaces(cwd?: string): Promise<WorkspaceEntry[]>;
export function inspectWorkspace(cwd?: string): Promise<WorkspaceEntry | null>;
export function listWorkspaces(cwd?: string, options?: { readOnly?: boolean }): Promise<WorkspaceEntry[]>;
export type RevisionFacts = { changeId: string; commitId: string; empty: boolean; conflict: boolean; description: string };
export function revisionFacts(cwd: string, revision: string): Promise<RevisionFacts>;
export function findWorkspace(cwd: string, name: string): Promise<WorkspaceEntry>;
export function attachWorkspaceIssue(
  cwd: string,
  issueNumber: number,
): Promise<WorkspaceMetadata & { issueNumber: number }>;
export function renameWorkspace(
  cwd: string,
  desired: string,
): Promise<{ oldName: string; name: string }>;
export function projectPrefix(cwd?: string): Promise<string | null>;
/** Top-level landing-state sidecar path for a workspace. */
export function statePath(workspaceName: string): string;
export function metadataPath(workspaceName: string): string;
export function workspaceMetadata(workspaceName: string): Promise<WorkspaceMetadata | null>;
/** Legacy per-workspace owner record; a live `pid` in it marks the workspace in use. */
export function lockPath(workspaceName: string): string;
/** Landing-state sidecar paths: the current top-level file, then the legacy `landed/` file. */
export function landingStatePaths(workspaceName: string): [string, string];
/** A landing record from either sidecar; an interrupted `prepared` record whose artifact is integrated is promoted to `landed` unless `readOnly`. */
export function readLandingState(workspaceName: string, options?: { readOnly?: boolean }): Promise<Record<string, unknown> & {
  version: number; phase?: "prepared" | "landed"; workspaceName: string; workspacePath: string; integrationBranch: string; artifactCommitId: string;
} | null>;
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
export function landWorkspace(cwd?: string, options?: LandingTailOptions & {
  allowDefaultWorkspace?: boolean;
  operationId?: string;
  onStage?: (stage: "preparing" | "rebasing" | "verifying" | "integrating" | "cleaning") => void;
  adapter?: LandingAdapter;
  /** `false` for a host that releases its own checkout records; others' disposable workspaces are otherwise swept after landing. */
  sweepOtherWorkspaces?: boolean;
  /** Receives one concise line per verification step; defaults to stdout. */
  onProgress?: (line: string) => void;
  /** Environment for the background post-land verification; defaults to `environment`. */
  postLandEnvironment?: () => NodeJS.ProcessEnv;
  /** Detached command that runs one post-land record file (appended), for a caller that exits after landing; long-lived hosts omit it and run in-process. */
  postLandRunner?: string[];
}): Promise<LandingTail & {
  artifact: LandingRevision; context: WorkspaceContext;
  cleanupPending?: boolean; cleanupError?: string;
  /** Whether the primary checkout was moved onto the new integration or left in place. */
  primaryCheckout?: import("./landing-candidate.mjs").PrimaryCheckoutOutcome;
  verification: import("./verification-policy.mjs").VerificationEvidence;
  /** The integration branch tip this landing verified against and advanced; absent when a rerun only republished. */
  base?: string;
  /** The declared background verification this landing started. */
  postLand?: { status: string; commit?: string; log?: string; reason?: string };
  /** An earlier landing's background verification on this repository did not pass. */
  postLandWarning?: string;
}>;
export function landingPreview(cwd?: string, options?: { allowDefaultWorkspace?: boolean }): Promise<{
  context: WorkspaceContext;
  targetRevision: string;
  target: RevisionFacts;
  stat: string;
}>;
export { cleanupLandedWorkspace, provisionSpare, readySpares, removeWorkspace, retireWorkspace, startSpareRefill, withinWorkspaceStorage, type RetirementHooks } from "./workspace-lifecycle.mjs";
export { pruneEmptyWorkspaces, sweepDisposableWorkspaces } from "./workspace-sweep.mjs";
export { createWorkspace, findIssueWorkspace, recoverIssueWorkspace, type CreatedWorkspace, type WorkspaceCreationHooks } from "./workspace-create.mjs";
import type { createWorkspace } from "./workspace-create.mjs";
export function assertIssueAvailable(cwd: string, issueNumber: number | undefined, intendedWorkspace: string): Promise<void>;
export function workspaceSlug(value: string, limit?: number): string;
export function taskWorkspaceName(project: string, issueNumber?: number | null): string;
export function parseWorkspaceList(output: string): Array<Pick<WorkspaceEntry, "name" | "root" | "changeId" | "commitId">>;

export function assertWorkspaceMutationAllowed(context: WorkspaceContext): Promise<void>;

export function normalizeDeclaredVerification(value: unknown): WorkspaceContext["configuration"]["requiredLocalVerification"];
export function assertWorkspaceDelivered(cwd: string): Promise<Record<string, unknown>>;
export function prepareWorkspaceContinuation(task: string, cwd: string): ReturnType<typeof createWorkspace>;

export function workspaceContinuationState(
  context: WorkspaceContext | null,
): Promise<import("./workspace-delivery-lifecycle.mjs").WorkspaceContinuationDisposition>;

export function workspaceHasUnintegratedWork(workspaceRoot: string, integrationBranch: string): Promise<boolean>;

export { latestPostLandResult, runPostLandVerification } from "./post-land-verification.mjs";
export function finishLandedWorkspace(context: import("./landing-candidate.mjs").CandidateContext, state: Record<string, unknown>): Promise<{ cleanupPending: boolean; cleanupError?: string; primaryCheckout?: import("./landing-candidate.mjs").PrimaryCheckoutOutcome }>;
