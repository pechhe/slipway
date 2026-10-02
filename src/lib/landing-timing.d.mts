export function landingTimingLine(
  timing: { startedAt: number; finishedAt: number; stages: ReadonlyArray<readonly [string, number]> },
  result: {
    postIntegration?: { ok: boolean; status: string; coveredByCommitSha?: string };
    timings?: { finalizingStartedAt: number; publishingStartedAt: number; finishedAt: number };
  },
): string;
