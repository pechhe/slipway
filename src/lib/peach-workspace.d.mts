export interface WorkspaceMetadata {
  issueNumber?: number;
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
  configuration: {
    integrationBranch?: string;
    requiredLocalVerification: import("./verification-policy.mjs").VerificationDeclaration[];
    /** Remote the integration branch is pushed to after landing; null when undeclared. */
    remote?: string | null;
  };
}
export class CommandError extends Error {}
export function explicitIssueNumber(value?: string | null): number | null;
export function readWorkspaceMode(): Promise<"isolated" | "direct">;
export function writeWorkspaceMode(mode: "isolated" | "direct"): Promise<"isolated" | "direct">;
export function workspaceContext(cwd?: string, integratedBranch?: string): Promise<WorkspaceContext | null>;
export function jjWorkspaceRoot(cwd: string): Promise<string | null>;
export function inspectWorkspaces(cwd?: string): Promise<WorkspaceEntry[]>;
export function inspectWorkspace(cwd?: string): Promise<WorkspaceEntry | null>;
export function listWorkspaces(cwd?: string): Promise<WorkspaceEntry[]>;
export function findWorkspace(cwd: string, name: string): Promise<WorkspaceEntry>;
export function findIssueWorkspace(
  cwd: string,
  issueNumber: number,
): Promise<WorkspaceEntry | null>;
export function attachWorkspaceIssue(
  cwd: string,
  issueNumber: number,
): Promise<WorkspaceMetadata & { issueNumber: number }>;
export function createWorkspace(
  task: string,
  cwd?: string,
  options?: { issueNumber?: number },
): Promise<WorkspaceContext & { workspacePath: string; reused?: boolean }>;
export function renameWorkspace(
  cwd: string,
  desired: string,
): Promise<{ oldName: string; name: string }>;
export function projectPrefix(cwd?: string): Promise<string>;
export function removeWorkspace(
  cwd: string,
  workspaceName: string,
  options?: { allowWork?: boolean; allowIssue?: boolean },
): Promise<void>;
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
  finish?: (context: WorkspaceContext, state: Record<string, unknown>) => Promise<{ cleanupPending: boolean; cleanupError?: string }>;
};
export function landWorkspace(cwd?: string, options?: LandingTailOptions & {
  allowDefaultWorkspace?: boolean;
  operationId?: string;
  onStage?: (stage: "preparing" | "rebasing" | "verifying" | "integrating" | "cleaning") => void;
  adapter?: LandingAdapter;
  /** Receives one concise line per verification step; defaults to stdout. */
  onProgress?: (line: string) => void;
}): Promise<LandingTail & {
  artifact: LandingRevision; context: WorkspaceContext;
  cleanupPending?: boolean; cleanupError?: string;
  verification: import("./verification-policy.mjs").VerificationEvidence;
}>;
export function landingPreview(cwd?: string): Promise<{
  context: WorkspaceContext;
  targetRevision: string;
  target: { changeId: string; commitId: string };
  stat: string;
}>;
export { cleanupLandedWorkspace, provisionSpare, readySpares } from "./workspace-lifecycle.mjs";

export function assertWorkspaceMutationAllowed(context: WorkspaceContext): Promise<void>;

export function normalizeDeclaredVerification(value: unknown): WorkspaceContext["configuration"]["requiredLocalVerification"];
export function assertWorkspaceDelivered(cwd: string): Promise<Record<string, unknown>>;
export function prepareWorkspaceContinuation(task: string, cwd: string): ReturnType<typeof createWorkspace>;

export function workspaceContinuationState(
  context: WorkspaceContext | null,
): Promise<import("./workspace-delivery-lifecycle.mjs").WorkspaceContinuationDisposition>;

export function workspaceHasUnintegratedWork(workspaceRoot: string, integrationBranch: string): Promise<boolean>;
