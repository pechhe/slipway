import { Effect } from "effect";
import lockfile from "proper-lockfile";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { readExactExecutionPolicy } from "./post-integration-source.mjs";
import { sourcePublicationPolicy, sourcePublicationPolicyDigest } from "./source-publication-policy.mjs";
import { writeWorkspaceJson } from "./workspace-transaction.mjs";
import { EXACT_COMMIT, publicationDigest, publicationEnvironment, publicationIO, PublicationFailure } from "./source-publication-io.mjs";

function withPublicationLease(directory, identity, operation) {
  const abort = new AbortController();
  return Effect.runPromise(Effect.acquireUseRelease(
    Effect.tryPromise(() => lockfile.lock(path.join(directory, "target-" + identity), {
      realpath: false, stale: 120_000, update: 10_000,
      retries: { retries: 200, minTimeout: 25, maxTimeout: 100 }, onCompromised: () => abort.abort(),
    })),
    () => Effect.tryPromise(() => operation(abort.signal)),
    (release) => Effect.promise(release),
  ));
}

async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!value || value.version !== 1 || !["running", "failed", "complete", "local_only"].includes(value.status)
      || value.sourceIntegrated !== true || !Number.isInteger(value.attempt) || value.attempt < 0
      || value.ok !== ["complete", "local_only"].includes(value.status)
      || !EXACT_COMMIT.test(value.integratedCommitSha) || value.targetCommitSha !== value.integratedCommitSha
      || (value.status === "complete" && (!EXACT_COMMIT.test(value.observedRemoteSha) || !["exact", "descendant"].includes(value.coverage)))) {
      throw new Error("Invalid source publication state; preserve it for reconciliation");
    }
    return value;
  } catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

/** Exact-artifact publication. No mutable bookmark is ever used as a push refspec. */
export async function finalizeSourcePublication(input) {
  const commit = input.integratedCommitSha;
  const branch = input.integrationBranch;
  if (!EXACT_COMMIT.test(commit ?? "")) throw new Error("An exact integrated commit is required");
  if (typeof branch !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)) throw new Error("A safe integration branch is required");
  if (input.localOnly !== undefined && typeof input.localOnly !== "boolean") throw new Error("localOnly must be an explicit boolean");
  const environment = input.environment ?? publicationEnvironment;
  const exact = await readExactExecutionPolicy(input.gitDirectory, commit, environment);
  const policy = sourcePublicationPolicy(exact.configuration?.sourcePublication);
  const localFacts = { sourceIntegrated: true, integratedCommitSha: commit, integrationBranch: branch };
  if (!policy) return { ...localFacts, ok: true, status: input.localOnly === true ? "local_only" : "not_declared" };
  if (exact.configuration.integrationBranch !== branch) throw new Error("Publication ref conflicts with exact integrated repository policy");
  const directory = input.stateDirectory ?? path.join(homedir(), ".pi", "agent", "workspace-state", "source-publication");
  // Stable artifact lookup: changing a remote, branch or policy cannot manufacture a fresh approval.
  const file = path.join(directory, publicationDigest([exact.gitDirectory, commit]) + ".json");
  const policyDigest = sourcePublicationPolicyDigest(policy);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return withPublicationLease(directory, publicationDigest([exact.gitDirectory, branch]), async (leaseSignal) => {
    const signal = input.abortSignal ? AbortSignal.any([input.abortSignal, leaseSignal]) : leaseSignal;
    const io = publicationIO(exact.gitDirectory, environment, signal);
    const previous = await readState(file);
    const base = { version: 1, ...localFacts, targetCommitSha: commit, remote: policy.remote, policyDigest };
    if (previous && (previous.integratedCommitSha !== commit || previous.targetCommitSha !== commit
      || previous.integrationBranch !== branch || previous.remote !== policy.remote || previous.policyDigest !== policyDigest)) {
      throw new Error("Source publication identity drift requires reconciliation");
    }
    const localOnly = input.localOnly ?? previous?.localOnly ?? false;
    if (localOnly && previous && ["running", "failed"].includes(previous.status) && !previous.localOnly) {
      return { ...previous, ok: false, status: "failed", code: "publication_intent_changed",
        reason: "A local-only override cannot erase an earlier publication attempt; reconcile its remote outcome first" };
    }
    if (input.inspectOnly === true) return previous ?? { ...base, ok: false, status: "pending", attempt: 0,
      reason: "Required source publication has not been completed" };
    if (previous?.status === "local_only" && localOnly) return previous;
    if (localOnly && previous?.status !== "complete") {
      const local = { ...base, ...(previous?.destinationDigest ? { destinationDigest: previous.destinationDigest, idempotencyKey: previous.idempotencyKey } : {}),
        ok: true, status: "local_only", localOnly: true, attempt: previous?.attempt ?? 0 };
      await writeWorkspaceJson(file, local);
      return local;
    }
    let evidence = { ...base, localOnly: false, attempt: (previous?.attempt ?? 0) + 1 };
    try {
      await io.run(["check-ref-format", "refs/heads/" + branch]);
      const destination = await io.destination(policy.remote);
      const identity = publicationDigest([exact.gitDirectory, commit, branch, policyDigest, destination.digest]);
      if (previous?.destinationDigest && (previous.destinationDigest !== destination.digest || previous.idempotencyKey !== identity)) {
        throw new PublicationFailure("destination_changed", "Push destination changed since the accepted publication; reconcile explicitly");
      }
      evidence = { ...evidence, destinationDigest: destination.digest, idempotencyKey: identity };
      const assertIntegrated = async () => {
        const tip = (await input.readIntegrationTip()).trim();
        if (!EXACT_COMMIT.test(tip) || !await io.ancestor(commit, tip)) {
          throw new PublicationFailure("integration_drift", "Exact artifact is no longer in the authoritative integration history");
        }
        if ((await io.destination(policy.remote)).digest !== destination.digest) {
          throw new PublicationFailure("destination_changed", "Configured push destination changed during publication");
        }
        if (signal.aborted) throw new PublicationFailure("interrupted", "Publication interrupted; reconcile the remote before retrying");
      };
      await assertIntegrated();
      const ref = "refs/heads/" + branch;
      let observed = await io.remoteHead(destination.url, ref);
      let covered = observed === commit || await io.ancestor(commit, observed);
      if (!covered) {
        if (previous?.status === "complete") throw new PublicationFailure("remote_regressed", "Previously verified remote source disappeared; do not republish without reconciliation");
        if (!await io.ancestor(observed, commit)) throw new PublicationFailure("remote_diverged", "Remote integration ref diverged from the exact publication target");
        evidence = { ...evidence, ...(await io.outgoing(observed, commit)), remoteBeforeSha: observed };
        await writeWorkspaceJson(file, { ...evidence, ok: false, status: "running" });
        await assertIntegrated();
        const pushed = await io.push(destination.url, ref, commit);
        // A timeout or lost response is unknown, never rejection. Read the destination before deciding.
        observed = await io.remoteHead(destination.url, ref);
        covered = observed === commit || await io.ancestor(commit, observed);
        if (!covered) throw new PublicationFailure(pushed.timedOut || pushed.cancelled ? "remote_outcome_unknown" : "push_rejected",
          "GitHub source publication was not verified; check credentials, network and branch protection, then retry this artifact");
      }
      await assertIntegrated();
      // Keep the first valid receipt stable across later authorised remote descendants and bookkeeping retries.
      if (previous?.status === "complete") return previous;
      const complete = { ...evidence, ok: true, status: "complete",
        observedRemoteSha: observed, coverage: observed === commit ? "exact" : "descendant" };
      await writeWorkspaceJson(file, complete);
      return complete;
    } catch (error) {
      const failed = { ...evidence, ok: false, status: "failed", code: error instanceof PublicationFailure ? error.code : "publication_failed",
        reason: error instanceof PublicationFailure ? error.message : "Source publication could not complete; preserve the artifact and retry finalization" };
      // Never erase a prior proven receipt because the network is temporarily unavailable.
      if (previous?.status !== "complete" && failed.code !== "destination_changed") await writeWorkspaceJson(file, failed);
      return failed;
    }
  });
}
