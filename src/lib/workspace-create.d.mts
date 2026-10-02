import type { WorkspaceContext, WorkspaceEntry } from "./workspace-jj.mjs";

/** Host seams for assigning a workspace; each defaults to plain JJ or package-manager installation. */
export interface WorkspaceCreationHooks<Readiness = unknown> {
  addWorkspace?: (integrationRoot: string, workspacePath: string, baseSha: string, workspaceName: string) => Promise<unknown>;
  prepare?: (integrationRoot: string, workspacePath: string) => Promise<Readiness>;
  onAcquired?: (acquisition: { workspaceName: string; projectRoot: string; issueNumber: number | null }) => void;
  forget?: (integrationRoot: string, workspaceName: string, workspacePath: string) => Promise<void>;
}

export type CreatedWorkspace<Readiness = unknown> = WorkspaceContext & {
  context: WorkspaceContext;
  created: boolean;
  reused: boolean;
  pooled: boolean;
  workspacePath: string;
  readiness: Readiness;
};

export function createWorkspace<Readiness = unknown>(
  task: string,
  cwd?: string,
  options?: { issueNumber?: number; hooks?: WorkspaceCreationHooks<Readiness> },
): Promise<CreatedWorkspace<Readiness>>;
export function findIssueWorkspace(
  cwd: string,
  issueNumber: number,
  hooks?: Pick<WorkspaceCreationHooks, "forget">,
): Promise<WorkspaceEntry | null>;
export function recoverIssueWorkspace(
  cwd: string,
  options: { issueNumber: number; workspaceName: string; changeId?: string; commitId?: string },
  hooks?: WorkspaceCreationHooks,
): Promise<WorkspaceContext>;
