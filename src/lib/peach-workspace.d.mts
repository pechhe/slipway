export interface WorkspaceLock {
  pid: number;
}
export interface WorkspaceMetadata {
  issueNumber?: number;
}
export interface WorkspaceEntry {
  name: string;
  root: string;
  changeId: string;
  commitId: string;
  hasWork: boolean;
  lock?: WorkspaceLock | null;
  metadata?: WorkspaceMetadata | null;
}
export interface WorkspaceContext {
  current: WorkspaceEntry;
  integration: WorkspaceEntry;
  integrationBranch: string;
  configuration: {
    integrationBranch?: string;
    requiredLocalVerification: Array<{ executable: string; args: unknown[]; cwd?: string }>;
  };
}
export class CommandError extends Error {}
export function explicitIssueNumber(value?: string | null): number | null;
export function readWorkspaceMode(): Promise<"isolated" | "direct">;
export function writeWorkspaceMode(mode: "isolated" | "direct"): Promise<"isolated" | "direct">;
export function workspaceContext(cwd?: string): Promise<WorkspaceContext | null>;
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
export function landWorkspace(
  cwd?: string,
): Promise<{ artifact: { commitId: string }; context: WorkspaceContext }>;
export function landingPreview(cwd?: string): Promise<{
  context: WorkspaceContext;
  targetRevision: string;
  target: { changeId: string; commitId: string };
  stat: string;
}>;
export function cleanupLandedWorkspace(cwd?: string): Promise<{ cleaned: boolean }>;
export function acquireWorkspaceLock(
  context: WorkspaceContext,
  options?: { takeOver?: boolean },
): Promise<() => Promise<void>>;
