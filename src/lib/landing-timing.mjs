/** One terse line of elapsed seconds per landing stage, for the CLI's stderr. */
const seconds = (ms) => `${(Math.max(0, ms) / 1000).toFixed(1)}s`;

function finalizationLabel(postIntegration) {
  if (postIntegration?.status === "covered") return `covered by ${String(postIntegration.coveredByCommitSha).slice(0, 7)}`;
  if (postIntegration?.status === "complete") return "ran";
  if (postIntegration?.status === "not_declared") return "none";
  return postIntegration?.status ?? "unknown";
}

/**
 * `stages` are `[name, epochMs]` marks from `onStage`; the landing result's
 * `timings` adds finalization and publication. Each stage ends where the next starts.
 */
function stageDurations({ finishedAt, stages }, result) {
  const marks = [...stages];
  const timings = result?.timings;
  if (timings) {
    marks.push(["finalizing", timings.finalizingStartedAt]);
    if (result.postIntegration?.ok) marks.push(["publishing", timings.publishingStartedAt]);
  }
  return marks.map(([stage, at], index) => {
    const end = index + 1 < marks.length ? marks[index + 1][1] : timings?.finishedAt ?? finishedAt;
    return [stage, Math.max(0, end - at)];
  });
}

export function landingTimingLine(timing, result) {
  const parts = stageDurations(timing, result).map(([stage, ms]) => {
    const line = `${stage} ${seconds(ms)}`;
    return stage === "finalizing" ? `${line} (${finalizationLabel(result.postIntegration)})` : line;
  });
  return `[land] ${[...parts, `total ${seconds(timing.finishedAt - timing.startedAt)}`].join(" · ")}`;
}

/** The same figures as `landingTimingLine`, as one metrics record in milliseconds. */
export function landingTimingRecord(timing, result) {
  const stagesMs = {};
  for (const [stage, ms] of stageDurations(timing, result)) stagesMs[stage] = (stagesMs[stage] ?? 0) + ms;
  return { ok: Boolean(result?.ok), totalMs: timing.finishedAt - timing.startedAt, stagesMs,
    ...(result?.postIntegration?.status ? { finalization: result.postIntegration.status } : {}) };
}
