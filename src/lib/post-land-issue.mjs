/**
 * Turn a failed or errored post-land run into one GitHub Issue on the landed
 * repository, carrying the landing's context so a repair needs no original
 * session. The record is the idempotency key: once it names an Issue URL, no
 * other Issue is opened for that landed commit.
 */
import { runBoundedProcess } from "./bounded-process.mjs";

const GH_TIMEOUT_MS = 60_000;

/** `owner/name` of a GitHub remote in `jj git remote list` output, preferring `preferred`. */
export function githubRepository(remoteList, preferred) {
  const remotes = remoteList.split(/\r?\n/).map((line) => line.trim().split(/\s+/)).filter((parts) => parts.length >= 2)
    .map(([name, url]) => ({ name, repository: /github\.com[:/]([^\s/]+\/[^\s/]+?)(?:\.git)?\/?$/.exec(url)?.[1] ?? null }))
    .filter((remote) => remote.repository);
  return (remotes.find((remote) => remote.name === preferred) ?? remotes[0])?.repository ?? null;
}

/** The Issue a landing served: workspace metadata first, else a closing reference or `(#N)` in its description. */
export function originatingIssue(issueNumber, description) {
  if (Number.isInteger(issueNumber) && issueNumber > 0) return issueNumber;
  const match = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?)\s+#(\d+)\b/i.exec(description ?? "") ?? /\(#(\d+)\)/.exec(description ?? "");
  return match ? Number(match[1]) : null;
}

/** Whether `description` already refers to Issue `issueNumber` (`#N`, `Fixes #N`, or `owner/repo#N`). */
export function referencesIssue(description, issueNumber) {
  return new RegExp(`(?<![\\w&])#${issueNumber}(?!\\d)|[\\w.-]+/[\\w.-]+#${issueNumber}(?!\\d)`).test(description ?? "");
}

/** `description` plus an `Issue: owner/repo#N` git trailer, unless it has no Issue or already names it. */
export function withIssueTrailer(description, issueNumber, repository) {
  const text = (description ?? "").trimEnd();
  if (!Number.isInteger(issueNumber) || issueNumber <= 0 || referencesIssue(text, issueNumber)) return text;
  const trailer = `Issue: ${repository ?? ""}#${issueNumber}`;
  const paragraphs = text.split(/\n\s*\n/);
  const inTrailerBlock = paragraphs.length > 1 && paragraphs.at(-1).split("\n").every((line) => /^[A-Za-z][\w-]*: \S/.test(line));
  return `${text}${inTrailerBlock ? "\n" : "\n\n"}${trailer}`;
}

const firstLine = (record) => (record.description ?? "").split(/\r?\n/)[0].trim() || record.commit.slice(0, 12);

export function postLandIssueTitle(record) {
  return `Post-land verification ${record.status === "error" ? "errored" : "failed"}: ${firstLine(record)}`;
}

export function postLandIssueBody(record) {
  const fence = (text) => `\`\`\`\n${String(text ?? "").trimEnd()}\n\`\`\``;
  const failure = record.failed
    ? [`Failing command: \`${record.failed.command}\``, `Exit code: \`${record.failed.exitCode}\``, "", "Failure tail:", "", fence(record.failed.tail)]
    : [`Run error: ${record.reason ?? record.status}`];
  return [
    `Post-land verification of a landed commit ${record.status === "error" ? "errored" : "failed"}.`,
    "",
    `- Landed commit: \`${record.commit}\``,
    `- Base: \`${record.base}\``,
    `- Originating Issue: ${record.originatingIssue ? `#${record.originatingIssue}` : "unknown"}`,
    `- Log on the landing host: \`${record.log}\``,
    "",
    "## Landing description",
    "",
    fence(record.description ?? "(none recorded)"),
    "",
    "## Changes",
    "",
    fence(record.diffStat ?? "(not recorded)"),
    "",
    "## Failure",
    "",
    ...failure,
    "",
    `Rerun with \`PEACH_POST_LAND_BASE=${record.base} PEACH_POST_LAND_COMMIT=${record.commit}\` against the landed source.`,
  ].join("\n");
}

const ghRunner = (env) => async (args) => {
  const result = await runBoundedProcess({ executable: "gh", args, cwd: process.cwd(), env, timeoutMs: GH_TIMEOUT_MS, maxOutputBytes: 1024 * 1024 });
  if (result.exitCode !== 0) throw new Error(`gh ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout || result.signal || "timeout").toString().trim()}`);
  return result.stdout.trim();
};

/**
 * The `issue` field for a finished record. Never throws: a missing remote or
 * `gh` failure becomes `not_opened` with its reason. `gh` is injectable for tests.
 */
export async function openPostLandIssue(record, { env = process.env, gh = ghRunner(env) } = {}) {
  if (record.issue?.url) return record.issue;
  if (record.status !== "failed" && record.status !== "error") return record.issue;
  const repository = record.repository;
  if (!repository) return { status: "not_opened", reason: "the repository has no GitHub remote" };
  let url;
  try {
    url = await gh(["issue", "create", "--repo", repository, "--title", postLandIssueTitle(record), "--body", postLandIssueBody(record), "--label", "bug"]);
    url = url.split(/\r?\n/).find((line) => line.startsWith("https://github.com/")) ?? url;
  } catch (error) {
    return { status: "not_opened", reason: error instanceof Error ? error.message : String(error) };
  }
  return { status: "opened", url };
}

/** Link an opened Issue to the landing's originating Issue: a native blocked-by edge plus a comment. */
export async function linkPostLandIssue(record, { env = process.env, gh = ghRunner(env) } = {}) {
  const issue = record.issue;
  if (!issue?.url || !record.originatingIssue || issue.link) return issue;
  const number = /\/issues\/(\d+)$/.exec(issue.url)?.[1];
  try {
    if (!number) throw new Error(`cannot read an Issue number from ${issue.url}`);
    const id = await gh(["api", `repos/${record.repository}/issues/${number}`, "--jq", ".id"]);
    await gh(["api", "--method", "POST", `repos/${record.repository}/issues/${record.originatingIssue}/dependencies/blocked_by`, "-F", `issue_id=${id}`]);
    await gh(["issue", "comment", String(record.originatingIssue), "--repo", record.repository, "--body",
      `Post-land verification of \`${record.commit.slice(0, 12)}\` ${record.status === "error" ? "errored" : "failed"}; repair is tracked in ${issue.url}.`]);
    return { ...issue, link: { status: "linked", originatingIssue: record.originatingIssue } };
  } catch (error) {
    return { ...issue, link: { status: "not_linked", originatingIssue: record.originatingIssue, reason: error instanceof Error ? error.message : String(error) } };
  }
}
