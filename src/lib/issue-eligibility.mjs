/** GitHub eligibility is for automated dispatch, not permission to edit or land. */
export async function assertIssueEligible(root, issueNumber, integrationBranch, run) {
  if (!issueNumber) return;
  const remote = await run("jj", ["git", "remote", "list"], root);
  const repository = remote.match(/(?:github\.com[:/])([^\s]+?)(?:\.git)?(?:\s|$)/)?.[1];
  if (!repository) return;
  const pages = JSON.parse(
    await run(
      "gh",
      [
        "api",
        `repos/${repository}/issues/${issueNumber}/dependencies/blocked_by?per_page=100`,
        "--paginate",
        "--slurp",
      ],
      root,
    ),
  );
  for (const dependency of pages.flat())
    await assertCompletedIssueDelivered(root, dependency, repository, integrationBranch, run);
}

/** Closure is the coding agent's report after landing, not a separate receipt. */
export async function assertCompletedIssueDelivered(
  _root,
  dependency,
  repository,
  _integrationBranch,
  _run,
) {
  const dependencyRepository =
    /\/repos\/([^/]+\/[^/]+)$/.exec(dependency.repository_url ?? "")?.[1] ??
    /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(dependency.html_url ?? "")?.[1] ??
    repository;
  const reference = `${dependencyRepository}#${dependency.number}`;
  if (dependency.state !== "closed" || dependency.state_reason !== "completed") {
    throw new Error(
      `Delivery remains blocked by ${reference}; only completed delivery can satisfy a prerequisite`,
    );
  }
  return `${reference}: completed`;
}

/** Choose ready, unblocked work for an Issue-board or automated continuation. */
export async function selectImplementationIssue(root, scopeNumber, branch, run, readWorkspace) {
  if (!scopeNumber) return undefined;
  const remote = await run("jj", ["git", "remote", "list"], root);
  const repository = remote.match(/(?:github\.com[:/])([^\s]+?)(?:\.git)?(?:\s|$)/)?.[1];
  if (!repository) return scopeNumber;
  const api = async (suffix) =>
    JSON.parse(
      await run("gh", ["api", `repos/${repository}/${suffix}`, "--paginate", "--slurp"], root),
    ).flat();
  const [scope] = await api(`issues/${scopeNumber}`);
  if (!scope || scope.state !== "open") throw new Error(`Work #${scopeNumber} is no longer open`);
  const labels = (issue) =>
    (issue.labels ?? []).map((label) => (typeof label === "string" ? label : label.name));
  if (labels(scope).includes("programme") || labels(scope).includes("super-epic"))
    throw new Error("Select an Epic or Issue, not a Programme");
  const children = await api(`issues/${scopeNumber}/sub_issues?per_page=100`);
  if (children.length && !labels(scope).includes("epic"))
    throw new Error("Only an Epic may have child delivery units");
  const candidates = (children.length ? children : [scope])
    .filter((issue) => issue.state === "open")
    .sort((a, b) => a.number - b.number);
  const reasons = [];
  const eligible = [];
  for (const candidate of candidates) {
    const [issue] = await api(`issues/${candidate.number}`);
    const current = labels(issue ?? {});
    if (
      !issue ||
      issue.state !== "open" ||
      !current.includes("ready-for-agent") ||
      current.some((label) =>
        ["review", "discovery", "someday", "programme", "super-epic", "blocked: external"].includes(
          label,
        ),
      )
    ) {
      reasons.push(`#${candidate.number} is not ready`);
      continue;
    }
    if (
      current.includes("epic") &&
      (await api(`issues/${issue.number}/sub_issues?per_page=100`)).length
    ) {
      reasons.push(`#${issue.number} contains child delivery units`);
      continue;
    }
    try {
      await assertIssueEligible(root, issue.number, branch, run);
    } catch (error) {
      reasons.push(String(error));
      continue;
    }
    eligible.push(issue.number);
  }
  // Prefer resuming preserved work over allocating another child. Assignment
  // carries no exclusive writer authority and never requires a takeover.
  if (children.length && readWorkspace) {
    for (const number of eligible) if (await readWorkspace(number)) return number;
  }
  if (eligible.length) return eligible[0];
  throw new Error(
    candidates.length
      ? `No eligible child remains: ${reasons.join("; ")}`
      : `Scope #${scopeNumber} has no unfinished children`,
  );
}
