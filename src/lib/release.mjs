/**
 * `slipway release`: promote the published integration branch to the release
 * branch its committed policy declares. Without a confirmation it only plans: it
 * names the candidate (the integration branch on the remote), the base (the
 * release branch on the remote), the commits between them, any migration
 * artifacts and any half-built Specs (warned about, never refused). With `confirm`, the candidate commit id a human approved, it checks
 * that exact commit out on its own, runs `requiredReleaseVerification`, builds the
 * release merge, refuses unless its tree is the verified tree, and publishes it.
 *
 * jj commands ignore working copies, except creating the verification checkout,
 * which snapshots only the checkout the release runs from.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { readExecutionPolicyAtCommit } from "./execution-policy.mjs";
import { githubRepository } from "./post-land-issue.mjs";
import { halfBuiltSpecs } from "./release-specs.mjs";
import { runRequiredVerification } from "./required-verification.mjs";
import { prepareWorkspaceDependencies } from "./workspace-dependencies.mjs";
import { run, workspaceContext } from "./workspace-jj.mjs";
import { stateHome } from "./workspace-paths.mjs";

const COMMIT_PREFIX = /^[a-f0-9]{12,64}$/;
const releaseHome = () => join(stateHome(), "releases");

class ReleaseRefusal extends Error {
  constructor(message) {
    super(message);
    this.name = "ReleaseRefusal";
  }
}
const refuse = (message) => { throw new ReleaseRefusal(message); };

const jjRun = (cwd, args) => run("jj", ["--color=never", "--ignore-working-copy", ...args], { cwd });

async function jjOut(cwd, args) {
  const result = await jjRun(cwd, args);
  if (result.code !== 0) throw new Error(`jj ${args.slice(0, 2).join(" ")} failed: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout.trim();
}

const lines = (text) => text.split("\n").filter(Boolean);
const commitIds = async (cwd, revset) => lines(await jjOut(cwd, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"']));
const symbol = (name) => JSON.stringify(name);

async function commitOf(cwd, revset) {
  const result = await jjRun(cwd, ["log", "--no-graph", "-r", revset, "-T", 'commit_id ++ "\\n"']);
  const ids = result.code === 0 ? lines(result.stdout) : [];
  return ids.length === 1 ? ids[0] : null;
}

const fetch = (cwd, remote, branch) => jjRun(cwd, ["git", "fetch", "--remote", remote, "--branch", branch]);

/**
 * What a release from `cwd`'s repository would publish. `candidate` pins a commit
 * id (or 12+ character prefix) that must already be published on the integration
 * branch; by default the candidate is the integration branch on the remote.
 */
export async function planRelease(cwd = process.cwd(), { candidate: pinned } = {}) {
  const context = await workspaceContext(cwd);
  if (!context) refuse(`Not inside a Jujutsu repository: ${cwd}`);
  const root = context.current.root;
  const integrationBranch = context.integrationBranch;
  const remote = context.configuration.remote;
  if (!remote) refuse("slipway.json declares no publication remote; a release publishes the release branch to it");

  const fetched = await fetch(root, remote, integrationBranch);
  if (fetched.code !== 0) refuse(`Could not fetch ${integrationBranch} from ${remote}: ${fetched.stderr.trim()}`);
  const published = `${symbol(integrationBranch)}@${symbol(remote)}`;
  if (pinned !== undefined && !COMMIT_PREFIX.test(pinned)) refuse("The release candidate must be a commit id or a prefix of at least 12 hex characters");
  const candidate = await commitOf(root, pinned ?? published);
  if (!candidate) refuse(pinned ? `No single commit matches ${pinned}` : `${integrationBranch}@${remote} does not exist`);
  if (!await commitOf(root, `${candidate} & ::${published}`)) refuse(`${candidate} is not published on ${integrationBranch}@${remote}`);

  // The candidate's own committed policy decides what a release of it requires.
  const { policy } = await readExecutionPolicyAtCommit(root, candidate);
  const releaseBranch = policy?.releaseBranch;
  if (!releaseBranch) refuse(`slipway.json at ${candidate.slice(0, 12)} declares no releaseBranch`);
  const checks = policy.requiredReleaseVerification;
  if (!checks) refuse(`slipway.json at ${candidate.slice(0, 12)} declares no requiredReleaseVerification (declare [] to release without checks)`);

  const fetchedRelease = await fetch(root, remote, releaseBranch);
  if (fetchedRelease.code !== 0) refuse(`Could not fetch ${releaseBranch} from ${remote}: ${fetchedRelease.stderr.trim()}`);
  const base = await commitOf(root, `${symbol(releaseBranch)}@${symbol(remote)}`);
  if (!base) refuse(`${releaseBranch}@${remote} does not exist; publish the release branch once before releasing to it`);

  const commits = lines(await jjOut(root, ["log", "--no-graph", "-r", `::${candidate} ~ ::${base}`,
    "-T", 'commit_id ++ "\\t" ++ description.escape_json() ++ "\\n"'])).map((line) => {
    const [commitId, encoded] = line.split("\t");
    const description = JSON.parse(encoded);
    return { commitId, subject: description.split("\n")[0], description };
  });
  const artifactPaths = policy.migrationFinalization?.artifactPaths ?? [];
  const changed = commits.length ? lines(await jjOut(root, ["diff", "--from", base, "--to", candidate, "--name-only"])) : [];
  const migrationArtifacts = changed.filter((file) => artifactPaths.some((path) => file === path || file.startsWith(`${path}/`)));
  return { root, integrationRoot: context.integration.root, remote, integrationBranch, releaseBranch,
    base, candidate, commits, migrationArtifacts, checks };
}

/** Check the candidate out on its own, prepare its dependencies and run the declared checks. */
async function verifyCandidate(plan, onProgress) {
  const short = plan.candidate.slice(0, 12);
  const name = `slipway-release-${short}`;
  const checkout = join(releaseHome(), "checkouts", short);
  await rm(checkout, { recursive: true, force: true });
  await mkdir(join(releaseHome(), "checkouts"), { recursive: true });
  // A leftover from an interrupted release would block the name.
  await jjRun(plan.root, ["workspace", "forget", name]);
  const added = await run("jj", ["--color=never", "workspace", "add", "--name", name, "--revision", plan.candidate, checkout], { cwd: plan.root });
  if (added.code !== 0) throw new Error(`jj workspace add failed: ${(added.stderr || added.stdout).trim()}`);
  try {
    if (!plan.checks.length) return { passed: [], gaps: [] };
    onProgress(`[release] preparing dependencies for ${short}`);
    await prepareWorkspaceDependencies(checkout, { quiet: true });
    return await runRequiredVerification({ checks: plan.checks, root: checkout, onProgress,
      slot: { scope: plan.integrationRoot, label: `release ${short}` } });
  } finally {
    const workingCopy = await commitOf(plan.root, `${symbol(name)}@`);
    await jjRun(plan.root, ["workspace", "forget", name]);
    if (workingCopy) await jjRun(plan.root, ["abandon", workingCopy]);
    await rm(checkout, { recursive: true, force: true });
  }
}

const releaseMessage = (plan) =>
  `Release ${plan.integrationBranch} to ${plan.releaseBranch}\n\nRelease-Candidate: ${plan.candidate}\n`;
const mergeRevset = (plan) =>
  `children(${plan.base}) & children(${plan.candidate}) & description(substring:${symbol(`Release-Candidate: ${plan.candidate}`)})`;

/** Build the release merge; refuse unless it is conflict-free and its tree is the candidate's. */
async function buildMerge(plan) {
  // Discard an unpublished merge left by an interrupted attempt.
  for (const stale of await commitIds(plan.root, mergeRevset(plan))) await jjRun(plan.root, ["abandon", stale]);
  await jjOut(plan.root, ["new", "--no-edit", "-m", releaseMessage(plan), plan.base, plan.candidate]);
  const merges = await commitIds(plan.root, mergeRevset(plan));
  if (merges.length !== 1) refuse(`Expected one release merge, found ${merges.length}`);
  const [merge] = merges;
  const conflicted = await jjOut(plan.root, ["log", "--no-graph", "-r", merge, "-T", 'if(conflict, "conflict", "")']);
  const differs = lines(await jjOut(plan.root, ["diff", "--from", plan.candidate, "--to", merge, "--name-only"]));
  if (conflicted || differs.length) {
    await jjRun(plan.root, ["abandon", merge]);
    refuse(`The release merge is not the verified tree (${conflicted ? "it conflicts" : `it also changes ${differs.slice(0, 10).join(", ")}`}): `
      + `${plan.releaseBranch} has changes ${plan.integrationBranch} lacks. Integrate them into ${plan.integrationBranch} first.`);
  }
  return merge;
}

/** Move the release bookmark to the merge and push it; jj refuses if the remote moved since the fetch. */
async function publish(plan, merge) {
  const bookmark = symbol(plan.releaseBranch);
  await jjRun(plan.root, ["bookmark", "track", `${bookmark}@${symbol(plan.remote)}`]);
  await jjOut(plan.root, ["bookmark", "set", plan.releaseBranch, "-r", merge]);
  const pushed = await jjRun(plan.root, ["git", "push", "--remote", plan.remote, "--bookmark", plan.releaseBranch]);
  await fetch(plan.root, plan.remote, plan.releaseBranch);
  if (await commitOf(plan.root, `${merge} & ::${bookmark}@${symbol(plan.remote)}`)) return;
  await jjRun(plan.root, ["bookmark", "set", plan.releaseBranch, "--allow-backwards", "-r", `${bookmark}@${symbol(plan.remote)}`]);
  await jjRun(plan.root, ["abandon", merge]);
  refuse(`Push of ${plan.releaseBranch} to ${plan.remote} failed: ${(pushed.stderr || pushed.stdout).trim() || "the remote does not contain the release"}`);
}

/**
 * Plan, or with `confirm` verify and publish, a release. `confirm` is the
 * candidate commit a human approved; `migrationsReady` acknowledges that the
 * release's migration artifacts are already applied where it deploys.
 */
export async function releaseIntegration(cwd = process.cwd(), { confirm, migrationsReady = false, onProgress = () => {}, graphql } = {}) {
  try {
    const plan = await planRelease(cwd, confirm === undefined ? {} : { candidate: confirm });
    const summary = { integrationBranch: plan.integrationBranch, releaseBranch: plan.releaseBranch, remote: plan.remote,
      base: plan.base, candidate: plan.candidate, commits: plan.commits.length, migrationArtifacts: plan.migrationArtifacts,
      checks: plan.checks.map((check) => [check.executable, ...check.args].join(" ")) };
    if (!plan.commits.length) return { ok: true, status: "up_to_date", ...summary };
    // Re-read on every plan and confirm: a Spec's Tickets may have closed in between.
    const remotes = await jjRun(plan.root, ["git", "remote", "list"]);
    summary.halfBuiltSpecs = await halfBuiltSpecs(remotes.code === 0 ? githubRepository(remotes.stdout, plan.remote) : null,
      plan.commits.map((commit) => commit.description), { graphql });
    if (confirm === undefined) {
      return { ok: true, status: "planned", ...summary, subjects: plan.commits.map((commit) => commit.subject),
        next: `After explicit human approval: slipway release --confirm ${plan.candidate.slice(0, 12)}`
          + (plan.migrationArtifacts.length ? " --migrations-ready (once these migrations are applied where the release deploys)" : "") };
    }
    if (plan.migrationArtifacts.length && !migrationsReady) {
      refuse(`This release carries migration artifacts (${plan.migrationArtifacts.join(", ")}). Apply them where ${plan.releaseBranch} deploys, then rerun with --migrations-ready.`);
    }
    const verification = await verifyCandidate(plan, onProgress);
    // The base must still be what was planned: a moved release branch needs a new plan.
    await fetch(plan.root, plan.remote, plan.releaseBranch);
    const base = await commitOf(plan.root, `${symbol(plan.releaseBranch)}@${symbol(plan.remote)}`);
    if (base !== plan.base) refuse(`${plan.releaseBranch}@${plan.remote} moved during the release; rerun it`);
    const merge = await buildMerge(plan);
    await publish(plan, merge);
    const record = { ...summary, merge, verification, releasedAt: new Date().toISOString() };
    await mkdir(releaseHome(), { recursive: true });
    await writeFile(join(releaseHome(), `${record.releasedAt.replace(/[:.]/g, "-")}-${plan.candidate.slice(0, 12)}.json`), `${JSON.stringify(record, null, 2)}\n`);
    return { ok: true, status: "released", ...record };
  } catch (error) {
    if (error instanceof ReleaseRefusal) return { ok: false, status: "refused", reason: error.message };
    if (error?.name === "RequiredVerificationError") return { ok: false, status: "verification_failed", reason: error.message, evidence: error.evidence };
    throw error;
  }
}
