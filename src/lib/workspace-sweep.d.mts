export const EMPTY_IDLE_MS: number;
export interface SweepResult {
  removed: string[];
  /** `landed` marks a delivered checkout the sweep could not release. */
  skipped: Array<{ name: string; landed: boolean; reason: string }>;
}
export function sweepDisposableWorkspaces(
  cwd?: string,
  options?: { emptyIdleMs?: number; protectedRoots?: string[]; now?: number },
): Promise<SweepResult>;
export function pruneEmptyWorkspaces(cwd?: string): Promise<SweepResult>;
