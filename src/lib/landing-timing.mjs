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
export function landingTimingLine({ startedAt, finishedAt, stages }, result) {
  const marks = [...stages];
  const timings = result?.timings;
  if (timings) {
    marks.push(["finalizing", timings.finalizingStartedAt]);
    if (result.postIntegration?.ok) marks.push(["publishing", timings.publishingStartedAt]);
  }
  const parts = marks.map(([stage, at], index) => {
    const end = index + 1 < marks.length ? marks[index + 1][1] : timings?.finishedAt ?? finishedAt;
    const line = `${stage} ${seconds(end - at)}`;
    return stage === "finalizing" ? `${line} (${finalizationLabel(result.postIntegration)})` : line;
  });
  return `[land] ${[...parts, `total ${seconds(finishedAt - startedAt)}`].join(" · ")}`;
}
