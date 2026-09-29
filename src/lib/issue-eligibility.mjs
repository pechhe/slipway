import { buildExecutionTopology } from "@peach-pi/shared-types";

/** Native GitHub relationships plus exact integration proof, never a cached graph. */
export async function assertIssueEligible(root, issueNumber, integrationBranch, run) {
  if (!issueNumber) return;
  const remote = await run("jj", ["git", "remote", "list"], root);
  const repository = remote.match(/(?:github\.com[:/])([^\s]+?)(?:\.git)?(?:\s|$)/)?.[1];
  // Local repositories without a GitHub remote have no GitHub work graph.
  if (!repository) return;
  const api = async (suffix, repo = repository) => JSON.parse(await run("gh", ["api", `repos/${repo}/${suffix}`, "--paginate", "--slurp"], root));
  const pages = await api(`issues/${issueNumber}/dependencies/blocked_by?per_page=100`);
  for (const dependency of pages.flat()) {
    const dependencyRepository = /\/repos\/([^/]+\/[^/]+)$/.exec(dependency.repository_url ?? "")?.[1]
      ?? /github\.com\/([^/]+\/[^/]+)\/issues\//.exec(dependency.html_url ?? "")?.[1]
      ?? repository;
    const reference = `${dependencyRepository}#${dependency.number}`;
    if (dependency.state !== "closed" || dependency.state_reason !== "completed") {
      throw new Error(`Issue #${issueNumber} is blocked by ${reference}; only completed delivery can satisfy a prerequisite`);
    }
    const sameRepository = dependencyRepository.toLowerCase() === repository.toLowerCase();
    const comments = (await api(`issues/${dependency.number}/comments?per_page=100`, dependencyRepository)).flat();
    const receipts = comments.filter((comment) => /^(?:Completed via Peach local integration\.|Completed via Peach GitHub source publication\.)/.test(comment.body ?? "")
      && /^Verification: passed(?:_with_gaps)?$/m.test(comment.body)
      && comment.body.includes(`<!-- peach-local-completion:${dependency.number}:`));
    let integrated = false;
    for (const receipt of receipts) {
      const commit = receipt.body.match(/^Integrated commit: `([a-f0-9]{40,64})`$/im)?.[1];
      if (!commit) continue;
      if (sameRepository) {
        const proof = await run("jj", ["--ignore-working-copy", "log", "--no-graph", "-r", `${commit} & ::${integrationBranch}`, "-T", "commit_id"], root).catch(() => "");
        if (proof.trim() !== commit) continue;
        if (receipt.body.startsWith("Completed via Peach local integration.") && /^Delivery: local integration$/m.test(receipt.body)) {
          integrated = true; break;
        }
      }
      // A foreign repository's commit must never be tested against this
      // checkout's ancestry or confused with an equal local Issue number.
      const publication = receipt.body.match(/^Source publication: complete; remote=[^;\n]+; ref=([^;\n]+); target=([a-f0-9]{40,64}); observed=[a-f0-9]{40,64}; coverage=(?:exact|descendant)$/im);
      if (!publication || publication[2] !== commit || !/^Delivery: git remote publication$/m.test(receipt.body)) continue;
      const ref = publication[1];
      if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(ref) || ref.includes("..")) continue;
      const [remote] = (await api(`git/ref/heads/${encodeURIComponent(ref)}`, dependencyRepository)).flat();
      const observed = remote?.object?.sha;
      if (observed === commit) { integrated = true; break; }
      if (!/^[a-f0-9]{40,64}$/i.test(observed ?? "")) continue;
      const [comparison] = (await api(`compare/${commit}...${observed}`, dependencyRepository)).flat();
      if (comparison?.status === "ahead" && comparison.merge_base_commit?.sha === commit) { integrated = true; break; }
    }
    if (!integrated && sameRepository) {
      const closed = (await api(`issues/${dependency.number}/timeline?per_page=100`)).flat().filter((event) => event.event === "closed").at(-1);
      if (/^[a-f0-9]{40,64}$/i.test(closed?.commit_id ?? "")) {
        const commit = closed.commit_id;
        integrated = (await run("jj", ["--ignore-working-copy", "log", "--no-graph", "-r", `${commit} & ::${integrationBranch}`, "-T", "commit_id"], root).catch(() => "")).trim() === commit;
      }
    }
    if (!integrated) throw new Error(`${reference} is closed but its exact accepted source is not proven delivered; Issue #${issueNumber} remains blocked`);
  }
}

/** Resolve an authorized Issue/Epic against live GitHub state on every boundary.
 * Route hints never bypass readiness, dependencies or current native ownership. */
export async function selectImplementationIssue(root, scopeNumber, branch, run, readWorkspace) {
  if (!scopeNumber) return undefined;
  const remote = await run("jj", ["git", "remote", "list"], root);
  const repository = remote.match(/(?:github\.com[:/])([^\s]+?)(?:\.git)?(?:\s|$)/)?.[1];
  if (!repository) return scopeNumber;
  const api = async (suffix) => JSON.parse(await run("gh", ["api", `repos/${repository}/${suffix}`, "--paginate", "--slurp"], root)).flat();
  const [scope] = await api(`issues/${scopeNumber}`);
  if (!scope || scope.state !== "open") throw new Error(`Work #${scopeNumber} is no longer open`);
  const children = await api(`issues/${scopeNumber}/sub_issues?per_page=100`);
  const labels = (issue) => (issue.labels ?? []).map((label) => typeof label === "string" ? label : label.name);
  if (labels(scope).includes("programme") || labels(scope).includes("super-epic")) throw new Error("Select an Epic or Issue, not a Programme");
  if (children.length && !labels(scope).includes("epic")) throw new Error("Only an Epic may have child delivery units");
  if (children.length && !readWorkspace) throw new Error("Epic continuation requires live native workspace ownership evidence");
  const candidates = (children.length ? children : [scope]).filter((issue) => issue.state === "open").sort((a, b) => a.number - b.number);
  const reasons = [];
  const eligible = [];
  const ownership = new Map();
  for (const candidate of candidates) {
    const [issue] = await api(`issues/${candidate.number}`);
    const current = labels(issue ?? {});
    if (!issue || issue.state !== "open" || !current.includes("ready-for-agent")
      || current.some((label) => ["discovery", "someday", "programme", "super-epic", "blocked: external"].includes(label))) {
      reasons.push(`#${candidate.number} is not ready`); continue;
    }
    if (current.includes("epic") && (await api(`issues/${issue.number}/sub_issues?per_page=100`)).length) {
      reasons.push(`#${issue.number} contains child delivery units`); continue;
    }
    try { await assertIssueEligible(root, issue.number, branch, run); }
    catch (error) { reasons.push(String(error)); continue; }
    if (children.length) {
      const workspace = await readWorkspace(issue.number);
      if (workspace?.lock) ownership.set(issue.number, workspace);
    }
    eligible.push({ issue, labels: current });
  }
  if (!eligible.length) {
    throw new Error(candidates.length ? `No eligible child remains: ${reasons.join("; ")}` : `Scope #${scopeNumber} has no unfinished children`);
  }
  if (!children.length) return eligible[0].issue.number;

  const work = eligible.map(({ issue, labels: current }) => ({
    issueNumber: issue.number,
    title: issue.title ?? `Issue ${issue.number}`,
    kind: current.includes("epic") ? "epic" : "issue",
    status: "ready",
    readiness: "agent",
    readinessLabel: "ready-for-agent",
    parentIssueNumber: null,
    blockedBy: [],
  }));
  const executions = [...ownership].map(([issueNumber, workspace]) => ({
    id: workspace.name,
    kind: "github",
    issueNumber,
    directTaskTitle: null,
    scopeIssueNumbers: [issueNumber],
    status: "active",
    ownerAgentRunId: null,
    worktreeId: workspace.name,
    prNumber: null,
    hasJujutsuWorkspace: true,
    hasReviewedDelivery: false,
    deliveryValid: false,
    prState: null,
    workspaceStillActive: true,
    sourceEmpty: null,
    ownerLeaseExpired: false,
    releasedWorkspaceCleanupSafe: false,
  }));
  const topology = buildExecutionTopology({
    projectId: `continuation:${root}`,
    repository,
    capturedAt: new Date().toISOString(),
    work,
    routes: [],
    executions,
    agentRuns: [],
  });
  const safe = new Set(topology.safeExecutionUnits);
  for (const { issue } of eligible) {
    if (!safe.has(issue.number)) continue;
    // Earlier candidates can gain a writer while later children are refreshed.
    // Allocation still owns the atomic no-takeover check after selection.
    const workspace = await readWorkspace(issue.number);
    if (workspace?.lock) { ownership.set(issue.number, workspace); continue; }
    return issue.number;
  }

  for (const [issueNumber, workspace] of ownership) {
    reasons.push(`#${issueNumber} has a current writer in jj:${workspace.name}`);
  }
  throw new Error(`No eligible child remains: ${reasons.join("; ") || "current native ownership leaves no safe execution unit"}`);
}

/** A decomposed Epic keeps its lifecycle open when reconciling parent source. */
export async function issueHasChildDeliveryUnits(root, issueNumber, run) {
  if (!issueNumber) return false;
  const remote = await run("jj", ["git", "remote", "list"], root);
  const repository = remote.match(/(?:github\.com[:/])([^\s]+?)(?:\.git)?(?:\s|$)/)?.[1];
  if (!repository) return false;
  const children = JSON.parse(await run("gh", ["api", `repos/${repository}/issues/${issueNumber}/sub_issues?per_page=100`, "--paginate", "--slurp"], root)).flat();
  return children.length > 0;
}

/** Moving on requires completion bookkeeping for the exact accepted delivery unit. */
export async function assertIssueReconciled(root, issueNumber, commit, run) {
  if (!issueNumber) return;
  const remote = await run("jj", ["git", "remote", "list"], root);
  const repository = remote.match(/(?:github\.com[:/])([^\s]+?)(?:\.git)?(?:\s|$)/)?.[1];
  if (!repository) return;
  const api = async (suffix) => JSON.parse(await run("gh", ["api", `repos/${repository}/issues/${issueNumber}${suffix}`, "--paginate", "--slurp"], root)).flat();
  const [issue] = await api("");
  const comments = await api("/comments?per_page=100");
  const decomposed = (issue?.labels ?? []).some((label) => (typeof label === "string" ? label : label.name) === "epic")
    && await issueHasChildDeliveryUnits(root, issueNumber, run);
  if ((!decomposed && issue?.state !== "closed") || !comments.some((comment) =>
    comment.body?.startsWith(decomposed ? "Epic source reconciled via Peach local integration." : "Completed via Peach local integration.")
    && comment.body.includes(`<!-- peach-local-completion:${issueNumber}:`)
    && comment.body.includes("Verification: passed")
    && comment.body.includes("Integrated commit: `" + commit + "`"))) {
    throw new Error(`Reconcile completion of Issue #${issueNumber} before continuing`);
  }
}
