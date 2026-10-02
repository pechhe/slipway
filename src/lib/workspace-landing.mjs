import { integrateLandingCandidate, finishLanding } from "./landing-candidate.mjs";
import { completeLanding, artifactPublished, fetchIntegration, landingIO, landingPreview, publicationRemote, waitForLandingSlot } from "./landing-steps.mjs";
import { githubRepository, originatingIssue } from "./post-land-issue.mjs";
import { describePostLandFailure, latestPostLandResult, startPostLandVerification } from "./post-land-verification.mjs";
import { withVerificationSlot } from "./verification-slot.mjs";
import { createWorkspace } from "./workspace-create.mjs";
import { jj, revisionExists, revisionFacts, workspaceContext, workspaceHasUnintegratedWork } from "./workspace-jj.mjs";
import { assertWorkspaceMutationAllowed, readLandingState, workspaceMetadata } from "./workspace-state.mjs";
import { sweepDisposableWorkspaces } from "./workspace-sweep.mjs";
import { withWorkspaceTransaction } from "./workspace-transaction.mjs";

/**
 * The land command: one serialized landing of a workspace, its background
 * verification, and the delivered-source proof a continuation requires.
 */

/** Landing is one operation: fetch → rebase → verify → move bookmark → push. */
export async function landWorkspace(cwd = process.cwd(), options = {}) {
  const context = await workspaceContext(cwd);
  if (!context || (context.current.name === "default" && !options.allowDefaultWorkspace)) throw new Error("Landing requires an isolated jj workspace");
  options.onStage?.("preparing");
  if (options.localOnly !== undefined && typeof options.localOnly !== "boolean") throw new Error("localOnly must be an explicit boolean");
  const remote = publicationRemote(context, options.localOnly);
  const onProgress = options.onProgress ?? ((line) => console.log(line));
  // A failed background run on this repository is the next landing's to see.
  const postLandFailure = describePostLandFailure(await latestPostLandResult(context.integration.root));
  if (postLandFailure) onProgress(`[post-land] ${postLandFailure}`);
  // One landing at a time holds this repository's slot from fetch through push, so
  // the integration branch cannot move between this landing's rebase and bookmark.
  // The workspace's writer key serializes this landing with cleanup of the same checkout.
  const result = await withVerificationSlot(() => withWorkspaceTransaction(`writer:${context.current.name}`, () => landInSlot(cwd, context, remote, options)),
    waitForLandingSlot(context, onProgress));
  // Started outside the landing slot, so an in-process run queues on its own.
  const started = { ...result, ...await startPostLand(cwd, context, result, options.postLandRunner, options.postLandEnvironment ?? options.environment) };
  // Release other disposable checkouts after every CLI/extension landing. A host
  // that owns its checkout records (Peach desktop) opts out and releases them
  // itself. The sweep never fails the landing.
  if (result.ok && options.sweepOtherWorkspaces !== false) await sweepDisposableWorkspaces(context.integration.root, { protectedRoots: [cwd, context.current.root] }).catch(() => undefined);
  return postLandFailure ? { ...started, postLandWarning: postLandFailure } : started;
}

async function landInSlot(cwd, context, remote, options) {
  // Rebase onto the latest published integration; an offline fetch surfaces again at push.
  // The candidate's own context then reads the fetched bookmark's committed policy (D3).
  if (remote) await fetchIntegration(cwd, remote, context.integrationBranch);
  const integrate = async () => {
    const prior = await readLandingState(context.current.name);
    if (prior?.phase === "landed" && prior.workspacePath === context.current.root && prior.integrationRoot === context.integration.root && !await workspaceHasUnintegratedWork(cwd, context.integrationBranch)
      && await revisionExists(cwd, `${prior.artifactCommitId} & ::${context.integrationBranch}`)) {
      const cleanup = await finishLanding(context, prior, options, landingIO);
      return { context, artifact: await revisionFacts(cwd, prior.artifactCommitId), ...cleanup,
        verification: prior.verificationEvidence ?? { status: "passed", passed: prior.verificationCommands ?? [], gaps: [], policyDigest: "legacy" } };
    }
    if (context.current.name !== "default") await assertWorkspaceMutationAllowed(context);
    return landOwnedWorkspace(cwd, options);
  };
  const result = await integrate();
  const completed = await completeLanding(cwd, context, result.artifact.commitId, options);
  return { ...result, ...completed };
}

/** What a post-land failure Issue needs, read while the workspace and its metadata exist. */
async function postLandLandingContext(cwd, context, result) {
  const description = (await jj(cwd, ["--ignore-working-copy", "log", "-r", result.artifact.commitId, "--no-graph", "-T", "description"])
    .catch(() => result.artifact.description ?? "")).trim();
  const metadata = context.current.name === "default" ? null : await workspaceMetadata(context.current.name);
  const remotes = await jj(cwd, ["--ignore-working-copy", "git", "remote", "list"]).catch(() => "");
  const diffStat = await jj(cwd, ["--ignore-working-copy", "diff", "--from", result.base, "--to", result.artifact.commitId, "--stat"]).catch(() => null);
  return {
    description, diffStat,
    originatingIssue: originatingIssue(metadata?.issueNumber, description),
    repository: githubRepository(remotes, context.configuration.remote),
  };
}

/** A fresh integration starts the repository's declared background verification. */
async function startPostLand(cwd, context, result, runner, environment) {
  const checks = context.configuration.postLandVerification ?? [];
  if (!result.base || !checks.length) return {};
  try {
    const gitDirectory = await jj(cwd, ["--ignore-working-copy", "git", "root"]);
    const record = await startPostLandVerification({ integrationRoot: context.integration.root, gitDirectory, base: result.base, commit: result.artifact.commitId, checks, runner,
      landing: await postLandLandingContext(cwd, context, result),
      // The host's command environment, as for the landing's own verification.
      ...(environment ? { env: environment() } : {}) });
    return { postLand: { status: record.status, commit: record.commit, log: record.log } };
  } catch (error) {
    // The integration stands; only its background evidence is missing.
    return { postLand: { status: "not_started", reason: error instanceof Error ? error.message : String(error) } };
  }
}

// Called inside landWorkspace's slot: only the slot holder advances the integration
// branch, so the base this landing verifies is still current when it integrates.
function landOwnedWorkspace(cwd, options) {
  return integrateLandingCandidate(cwd, options, {
    ...landingIO,
    landingPreview: (root) => landingPreview(root, { allowDefaultWorkspace: options.allowDefaultWorkspace }),
  });
}

/** Exact source proof (landed, pushed, nothing new) before a session leaves this workspace. */
export async function assertWorkspaceDelivered(cwd) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") throw new Error("No current Issue workspace");
  const state = await readLandingState(context.current.name);
  const metadata = await workspaceMetadata(context.current.name);
  if (!state || state.phase !== "landed" || state.workspaceName !== context.current.name
    || state.workspacePath !== context.current.root || state.integrationRoot !== context.integration.root
    || state.integrationBranch !== context.integrationBranch
    || (state.issueNumber ?? null) !== (metadata?.issueNumber ?? null)
    || !await revisionExists(cwd, `${state.artifactCommitId} & ::${context.integrationBranch}`)
    || await workspaceHasUnintegratedWork(cwd, context.integrationBranch)) {
    throw new Error("Land the current workspace before continuing to another one");
  }
  if (!await artifactPublished(cwd, context, state)) throw new Error("Source integrated locally but not yet pushed; rerun land before continuing");
  return state;
}

/** A fresh workspace for this conversation's next task, once the current one is delivered. */
export async function prepareWorkspaceContinuation(task, cwd) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error("Continuation requires a JJ project");
  if (context.current.name !== "default") await assertWorkspaceDelivered(cwd);
  return createWorkspace(task, context.integration.root);
}
