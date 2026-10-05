export function landingTimingLine(
  timing: { startedAt: number; finishedAt: number; stages: ReadonlyArray<readonly [string, number]> },
  result: {
    postIntegration?: { ok: boolean; status: string; coveredByCommitSha?: string };
    timings?: { finalizingStartedAt: number; publishingStartedAt: number; finishedAt: number };
  },
): string;

export function landingTimingRecord(
  timing: { startedAt: number; finishedAt: number; stages: ReadonlyArray<readonly [string, number]> },
  result: {
    ok?: boolean;
    postIntegration?: { ok: boolean; status: string; coveredByCommitSha?: string };
    timings?: { finalizingStartedAt: number; publishingStartedAt: number; finishedAt: number };
  },
): { ok: boolean; totalMs: number; stagesMs: Record<string, number>; finalization?: string };
