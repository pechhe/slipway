import type { WorkspaceContext, WorkspaceEntry, WorkspaceMetadata } from "./workspace-jj.mjs";
export function readWorkspaceMode(): Promise<"isolated" | "direct">;
export function writeWorkspaceMode(mode: "isolated" | "direct"): Promise<"isolated" | "direct">;
export function inspectWorkspaces(cwd?: string): Promise<WorkspaceEntry[]>;
export function inspectWorkspace(cwd?: string): Promise<WorkspaceEntry | null>;
export function listWorkspaces(cwd?: string, options?: { readOnly?: boolean }): Promise<WorkspaceEntry[]>;
export function findWorkspace(cwd: string, name: string): Promise<WorkspaceEntry>;
export function attachWorkspaceIssue(
  cwd: string,
  issueNumber: number,
): Promise<WorkspaceMetadata & { issueNumber: number }>;
export function renameWorkspace(
  cwd: string,
  desired: string,
): Promise<{ oldName: string; name: string }>;
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
export function assertIssueAvailable(cwd: string, issueNumber: number | undefined, intendedWorkspace: string): Promise<void>;
export function assertWorkspaceMutationAllowed(context: WorkspaceContext): Promise<void>;
export function workspaceContinuationState(
  context: WorkspaceContext | null,
): Promise<import("./workspace-delivery-lifecycle.mjs").WorkspaceContinuationDisposition>;
export function readJsonOptional(path: string): Promise<any>;
