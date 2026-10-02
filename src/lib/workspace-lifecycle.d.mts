import type { WorkspaceEntry } from "./peach-workspace.mjs";
export function readySpares(cwd: string): Promise<WorkspaceEntry[]>;
export function provisionSpare(cwd?: string): Promise<{ provisioned: boolean; reason?: string; workspacePath?: string }>;
/** A claimed spare's provisioned dependencies, reused because its install inputs are unchanged. */
export interface ReusedDependencies {
  state: "ready" | "not_required";
  packageManager: string | null;
  installInputs: string;
  reused: true;
}
export function claimSpare(cwd: string, name: string): Promise<{ root: string; name: string; dependencies: ReusedDependencies | null } | null>;
/** Start a detached, `nice`d `provisionSpare` for the repository of `cwd`; resolves once the child has spawned. */
export function startSpareRefill(
  cwd?: string,
  options?: { command?: string[] },
): Promise<{ started: boolean; pid?: number; logPath?: string; reason?: string }>;
export function uniqueUntrackedMaterial(root: string, limit?: number, generated?: RegExp[]): Promise<string[]>;
export function retainedWorkspaceMaterial(root: string, integrationRoot: string, limit?: number): Promise<string[]>;
export function describeRetention(result: { reason?: string; paths?: string[] } | null | undefined): string;
/** Host seams for retiring a checkout: its guarded forget, lifecycle event and command environment. */
export interface RetirementHooks {
  forget?: (integrationRoot: string, workspaceName: string, workspacePath: string) => Promise<void>;
  onReleased?: (release: { workspaceName: string; projectRoot: string; issueNumber: number | null }) => void;
  environment?: () => NodeJS.ProcessEnv;
}
export function cleanupLandedWorkspace(cwd?: string, hooks?: RetirementHooks): Promise<{ cleaned: boolean; reason?: string; paths?: string[] }>;
export function withinWorkspaceStorage(root: string): Promise<boolean>;
export function forgetWorkspace(integrationRoot: string, workspaceName: string, workspacePath: string, hooks?: Pick<RetirementHooks, "forget">): Promise<void>;
export function retireWorkspace(integrationRoot: string, workspace: { name: string; root: string }, hooks?: RetirementHooks): Promise<void>;
export function removeWorkspace(
  cwd: string,
  workspaceName: string,
  options?: { allowWork?: boolean; allowIssue?: boolean },
): Promise<{ workspaceName: string; hasWork: boolean; issueNumber: number | null }>;
