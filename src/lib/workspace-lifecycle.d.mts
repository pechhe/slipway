export function uniqueUntrackedMaterial(root: string, limit?: number, generated?: RegExp[], primaryRoot?: string | null): Promise<string[]>;
export function retainedWorkspaceMaterial(root: string, integrationRoot: string, limit?: number): Promise<string[]>;
export function describeRetention(result: { reason?: string; paths?: string[] } | null | undefined): string;
/** Host seams for retiring a checkout: its guarded forget, lifecycle event and command environment. */
export interface RetirementHooks {
  forget?: (integrationRoot: string, workspaceName: string, workspacePath: string) => Promise<void>;
  onReleased?: (release: { workspaceName: string; projectRoot: string; issueNumber: number | null }) => void;
  environment?: () => NodeJS.ProcessEnv;
  /** Overrides the `workspaceTeardown` timeout (tests). */
  teardownTimeoutMs?: number;
  /** Called after cleanup's delivery checks and just before it retires the checkout (tests, hosts). */
  afterChecks?: () => void | Promise<void>;
}
/** Thrown by `retireWorkspace` when the working copy no longer matches `expectedCommitId`. */
export class WorkingCopyChangedError extends Error { code: "WORKING_COPY_CHANGED" }
export function cleanupLandedWorkspace(cwd?: string, hooks?: RetirementHooks): Promise<{ cleaned: boolean; reason?: string; paths?: string[];
  /** A failed post-integration record a later published landing superseded. */
  supersededPostIntegration?: { status: string; attempt: number; reason?: string } }>;
export function withinWorkspaceStorage(root: string): Promise<boolean>;
export function forgetWorkspace(integrationRoot: string, workspaceName: string, workspacePath: string, hooks?: Pick<RetirementHooks, "forget">): Promise<void>;
export function retireWorkspace(integrationRoot: string, workspace: { name: string; root: string }, hooks?: RetirementHooks, options?: { expectedCommitId?: string }): Promise<void>;
export function removeWorkspace(
  cwd: string,
  workspaceName: string,
  options?: { allowWork?: boolean; allowIssue?: boolean },
): Promise<{ workspaceName: string; hasWork: boolean; issueNumber: number | null }>;
