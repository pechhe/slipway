export const EMPTY_IDLE_MS: number;
export interface SweepResult {
  removed: string[];
  /** `landed` marks a delivered checkout the sweep could not release. */
  skipped: Array<{ name: string; landed: boolean; reason: string }>;
  /** State files removed for workspaces that no longer exist (relative to the state home). */
  pruned: string[];
}
export function sweepDisposableWorkspaces(
  cwd?: string,
  options?: { emptyIdleMs?: number; protectedRoots?: string[]; now?: number; pruneState?: boolean;
    /** Reads an Issue's state (`CLOSED` qualifies its empty workspace); defaults to `gh`. */
    issueState?: (repositoryRoot: string, issueNumber: number) => Promise<string | null> | string | null },
): Promise<SweepResult>;
export function pruneEmptyWorkspaces(cwd?: string): Promise<SweepResult>;
