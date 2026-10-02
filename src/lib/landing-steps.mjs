import { mkdir } from "node:fs/promises";
import { finishLanding } from "./landing-candidate.mjs";
import { finalizePostIntegration } from "./post-integration-finalization.mjs";
import { githubRepository, withIssueTrailer } from "./post-land-issue.mjs";
import { assertNoForeignPrimaryWriter } from "./primary-checkout-writer.mjs";
import { runRequiredVerification } from "./required-verification.mjs";
import { issueTitle, jj, revisionExists, revisionFacts, run, workspaceContext } from "./workspace-jj.mjs";
import { stateHome } from "./workspace-paths.mjs";
import { readJsonOptional, statePath, workspaceMetadata } from "./workspace-state.mjs";
import { writeWorkspaceJson } from "./workspace-transaction.mjs";

/**
 * The steps a landing is made of, below the land command itself: preview,
 * description, verification, the landing record, post-integration and the push.
 * Workspace housekeeping reuses them to finish a landing whose integration stands.
 */

async function writeLandingState(context, artifact, verification, phase = "landed", localOnly, operationId) {
  await mkdir(stateHome(), { recursive: true, mode: 0o700 });
  const metadata = await workspaceMetadata(context.current.name);
  const landedAt = new Date().toISOString();
  await writeWorkspaceJson(statePath(context.current.name), {
    version: 1, phase, operationId, cleanupPending: true, ...(localOnly !== undefined ? { localOnly } : {}), workspaceName: context.current.name, workspacePath: context.current.root,
    integrationRoot: context.integration.root, integrationBranch: context.integrationBranch,
    artifactCommitId: artifact.commitId, artifactChangeId: artifact.changeId,
    artifactDescription: artifact.description, verification: verification.status,
    verificationCommands: verification.passed, verificationEvidence: verification, landedAt,
    workspaceImplementationChangeId: metadata?.implementationChangeId,
    // No archive period: a delivered checkout is eligible for cleanup at landing.
    cleanupEligibleAt: landedAt,
    ...(typeof metadata?.issueNumber === "number" ? { issueNumber: metadata.issueNumber } : {}),
  });
}

export async function landingPreview(cwd = process.cwd(), options = {}) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Not inside a Jujutsu repository");
  if (context.current.name === "default" && !options.allowDefaultWorkspace)
    throw new Error("Landing requires an isolated jj workspace");
  const current = await revisionFacts(cwd, "@");
  const targetRevision = current.empty ? "@-" : "@";
  const target = await revisionFacts(cwd, targetRevision);
  if (target.conflict) throw new Error("The landing artifact has conflicts");
  const stat = await jj(cwd, ["diff", "--from", context.integrationBranch, "--to", targetRevision, "--stat"]);
  return { context, targetRevision, target, stat };
}

async function assertStackConflictFree(cwd, branch, changeId) {
  const conflicts = await jj(cwd, [
    "log",
    "-r",
    `conflicts() & (${branch}..${changeId})`,
    "--no-graph",
    "-T",
    'commit_id.short() ++ " " ++ description.first_line() ++ "\\n"',
  ]);
  if (conflicts.trim())
    throw new Error(
      `Rebase produced conflicts; resolve them in this workspace and retry:\n${conflicts}`,
    );
}

/** The verification-slot options of one landing, reporting its place in the queue. */
export const waitForLandingSlot = (context, onProgress = (line) => console.log(line)) => ({
  scope: context.integration.root,
  label: `jj:${context.current.name}`,
  onWait: ({ ahead, holder }) => onProgress(`[verify] waiting for the verification slot: ${ahead} landing${ahead === 1 ? "" : "s"} ahead${holder ? ` (${holder} holds it)` : ""}`),
});

async function runVerification(context, onProgress = (line) => console.log(line)) {
  // One landing of this repository verifies at a time; a landing already holds the slot.
  return await runRequiredVerification({ root: context.current.root, checks: context.configuration.requiredLocalVerification,
    onProgress, slot: waitForLandingSlot(context, onProgress) });
}

async function ensureLandingDescription(cwd, context, target) {
  const metadata = await workspaceMetadata(context.current.name);
  const issueNumber = typeof metadata?.issueNumber === "number" ? metadata.issueNumber : null;
  let description = target.description.trim();
  if (!description) {
    const issueDescription = issueNumber
      ? await issueTitle(context.integration.root, issueNumber)
      : null;
    const taskDescription = typeof metadata?.task === "string" ? metadata.task.trim() : "";
    description = (issueDescription?.trim() || taskDescription).slice(0, 500);
    // A post-land failure Issue carries this description; a placeholder would carry nothing.
    if (!description)
      throw new Error(`Landing needs a description of the change: run \`jj describe -r ${target.changeId} -m "<what this change does>"\` and land again`);
  }
  // The landed commit names its Issue itself, so attribution survives machine-local state.
  const remotes = issueNumber ? await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]).catch(() => "") : "";
  const described = withIssueTrailer(description, issueNumber, githubRepository(remotes, context.configuration.remote));
  if (described === target.description.trim() && target.description.trim()) return target;
  await jj(cwd, ["describe", "-r", target.changeId, "-m", described]);
  return revisionFacts(cwd, target.changeId);
}

/** The remote this landing publishes to, or null for local-only/undeclared delivery. */
export function publicationRemote(context, localOnly) {
  return localOnly === true ? null : context.configuration.remote ?? null;
}

export const fetchIntegration = (cwd, remote, branch) => run("jj", ["--color=never", "git", "fetch", "--remote", remote, "--branch", branch], { cwd });

/** Push the integration bookmark and confirm the remote-tracking bookmark contains the artifact. */
async function publishIntegration(cwd, remote, branch, commitId) {
  // A colocated import can leave the remote bookmark untracked; jj refuses to push it then.
  await run("jj", ["--color=never", "bookmark", "track", `${branch}@${remote}`], { cwd });
  const pushed = await run("jj", ["--color=never", "git", "push", "--remote", remote, "--bookmark", branch], { cwd });
  // A remote that another landing already advanced past this artifact also counts.
  if (pushed.code !== 0) await fetchIntegration(cwd, remote, branch);
  if (await revisionExists(cwd, `${commitId} & ::${branch}@${remote}`)) {
    return { ok: true, status: "pushed", remote, branch, commitId };
  }
  const detail = (pushed.stderr || pushed.stdout).trim();
  return { ok: false, status: "push_failed", remote, branch, commitId,
    reason: `Push of ${branch} to ${remote} failed${detail ? `: ${detail}` : ""}. The local integration is kept; rerun land to retry the push.` };
}

/**
 * The tail every landing shares once the integration bookmark has moved: the
 * repository's declared external-state step (for example a development database
 * migration), then the push. A blocked or failed step keeps the local
 * integration; rerunning land retries it without re-verifying landed source.
 */
export async function completeLanding(cwd, context, commitId, options = {}) {
  // Wall-clock stage starts for the CLI's timing line; not landing evidence.
  const timings = { finalizingStartedAt: Date.now() };
  // A secondary workspace never exports to the colocated Git repository, and an
  // Isolated landing may run no JJ command in the primary checkout, so export the
  // integration bookmark for Git-level consumers. Finalization reads the exact
  // object, not this ref, so an export JJ declines does not block publication.
  await jj(cwd, ["--ignore-working-copy", "git", "export"]);
  const gitDirectory = await jj(cwd, ["--ignore-working-copy", "git", "root"]);
  const postIntegration = await finalizePostIntegration({
    gitDirectory, integratedCommitSha: commitId, approval: options.postIntegrationApproval,
    // A retry after a later landing: a completed descendant with unchanged migration
    // inputs covers this artifact, or its exact source runs; drift still fails closed.
    recoverDescendant: true,
    readIntegrationTip: async () => (await revisionFacts(cwd, context.integrationBranch)).commitId,
    ...(options.environment ? { environment: options.environment } : {}),
  });
  timings.publishingStartedAt = Date.now();
  if (!postIntegration.ok) {
    return { ok: false, postIntegration, timings: { ...timings, finishedAt: timings.publishingStartedAt }, publication: { ok: false, status: "blocked", commitId,
      reason: `Post-integration ${postIntegration.status}${postIntegration.reason ? `: ${postIntegration.reason}` : ""}. The local integration is kept; resolve it and rerun land.` } };
  }
  const remote = publicationRemote(context, options.localOnly);
  const publication = remote
    ? await publishIntegration(cwd, remote, context.integrationBranch, commitId)
    : { ok: true, status: options.localOnly === true ? "local_only" : "not_declared", commitId };
  return { ok: publication.ok, postIntegration, publication, timings: { ...timings, finishedAt: Date.now() } };
}

/** True when the landed artifact is on the declared remote, or when no publication applies. */
export async function artifactPublished(cwd, context, state) {
  const remote = publicationRemote(context, state.localOnly);
  if (!remote) return true;
  await fetchIntegration(cwd, remote, context.integrationBranch);
  return revisionExists(cwd, `${state.artifactCommitId} & ::${context.integrationBranch}@${remote}`);
}

/** What the landing candidate (landing-candidate.mjs) needs from the land command. */
export const landingIO = {
  landingPreview, ensureLandingDescription, assertNoForeignPrimaryWriter, jj,
  assertStackConflictFree, revisionFacts, runVerification, writeLandingState,
  readJsonOptional, statePath,
};

/** Retry the housekeeping of a landing whose integration already stands. */
export function finishLandedWorkspace(context, state) {
  return finishLanding(context, state, {}, landingIO);
}
