export const EMPTY_IDLE_MS: number;
export interface SweepResult {
  removed: string[];
  skipped: Array<{ name: string; reason: string }>;
}
export function sweepDisposableWorkspaces(
  cwd?: string,
  options?: { emptyIdleMs?: number; protectedRoots?: string[]; now?: number },
): Promise<SweepResult>;
export function pruneEmptyWorkspaces(cwd?: string): Promise<SweepResult>;
