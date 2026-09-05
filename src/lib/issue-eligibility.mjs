/** Native GitHub relationships plus exact integration proof, never a cached graph. */
export async function assertIssueEligible(root, issueNumber, integrationBranch, run) {
  if (!issueNumber) return;
  const remote = await run("jj", ["git", "remote", "list"], root);
  const repository = remote.match(/(?:github\.com[:/])([^\s]+?)(?:\.git)?(?:\s|$)/)?.[1];
  // Local repositories without a GitHub remote have no GitHub work graph.
  if (!repository) return;
  const api = async (suffix) => JSON.parse(await run("gh", ["api", `repos/${repository}/${suffix}`, "--paginate", "--slurp"], root));
  const pages = await api(`issues/${issueNumber}/dependencies/blocked_by?per_page=100`);
  for (const dependency of pages.flat()) {
    if (dependency.state !== "closed") throw new Error(`Issue #${issueNumber} is blocked by #${dependency.number}; implementation cannot start before it lands`);
    const comments = (await api(`issues/${dependency.number}/comments?per_page=100`)).flat();
    const commits = comments.filter((comment) => comment.body?.startsWith("Completed via Peach local integration.") && comment.body.includes("Verification: passed") && comment.body.includes("Delivery: local integration") && comment.body.includes(`<!-- peach-local-completion:${dependency.number}:`))
      .map((comment) => comment.body.match(/Integrated commit: `([a-f0-9]{40,64})`/i)?.[1]).filter(Boolean);
    let integrated = false;
    for (const commit of commits) {
      const proof = await run("jj", ["log", "--no-graph", "-r", `${commit} & ::${integrationBranch}`, "-T", "commit_id"], root).catch(() => "");
      if (proof.trim() === commit) { integrated = true; break; }
    }
    if (!integrated) {
      // Compatibility with the explicit PR endpoint: GitHub's closing event
      // may name the integrating commit even when there is no local receipt.
      const closed = (await api(`issues/${dependency.number}/timeline?per_page=100`)).flat().filter((event) => event.event === "closed").at(-1);
      if (/^[a-f0-9]{40,64}$/i.test(closed?.commit_id ?? "")) {
        const commit = closed.commit_id;
        integrated = (await run("jj", ["log", "--no-graph", "-r", `${commit} & ::${integrationBranch}`, "-T", "commit_id"], root).catch(() => "")).trim() === commit;
      }
    }
    if (!integrated) throw new Error(`Issue #${dependency.number} is closed but its exact accepted change is not proven landed in ${integrationBranch}; Issue #${issueNumber} remains blocked`);
  }
}
