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
export function workspaceContext(cwd?: string, integratedBranch?: string): Promise<WorkspaceContext | null>;
export function jjWorkspaceRoot(cwd: string): Promise<string | null>;
export type RevisionFacts = { changeId: string; commitId: string; empty: boolean; conflict: boolean; description: string };
export function revisionFacts(cwd: string, revision: string): Promise<RevisionFacts>;
export function projectPrefix(cwd?: string): Promise<string | null>;
export function workspaceSlug(value: string, limit?: number): string;
export function projectCode(folderName: string): string;
export function taskWorkspaceName(project: string, issueNumber?: number | null, task?: string | null): string;
export function legacyIssueWorkspaceName(folderName: string, issueNumber: number): string;
export function parseWorkspaceList(output: string): Array<Pick<WorkspaceEntry, "name" | "root" | "changeId" | "commitId">>;
export function workspaceHasUnintegratedWork(workspaceRoot: string, integrationBranch: string): Promise<boolean>;
export function revisionExists(cwd: string, revision: string): Promise<boolean>;
export function issueTitle(repositoryRoot: string, issueNumber: number): Promise<string | null>;
/** Bounded jj/git/gh runner with the landing command environment. */
export const run: typeof import("./workspace-command.mjs").runWorkspaceCommand;
/** A checked `jj --color=never` call: its trimmed stdout, or a CommandError. */
export function jj(cwd: string, args: string[], options?: Record<string, unknown>): Promise<string>;
