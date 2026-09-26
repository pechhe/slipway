import { Effect } from "effect";
import lockfile from "proper-lockfile";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writeWorkspaceJson } from "./workspace-transaction.mjs";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.mjs";
import { exactPostIntegrationApproval, postIntegrationPolicyDigest } from "./post-integration-policy.mjs";
import { finalizationCwd, readExactExecutionPolicy, readPostIntegrationPolicy, withFinalizationSource } from "./post-integration-source.mjs";

class HistoricalMigrationFailure extends Error {}

async function historicalMigrationTip(input, gitDirectory, commit, policyDigest, environmentFactory, abortSignal) {
  const tip = (await input.readIntegrationTip()).trim();
  if (tip === commit) return;
  if (!input.recoverDescendant || !/^[a-f0-9]{40}$/.test(tip))
    throw new HistoricalMigrationFailure("Integration tip changed before finalization");
  const ancestor = await runBoundedProcess({
    executable: "git", args: ["--git-dir", gitDirectory, "merge-base", "--is-ancestor", commit, tip],
    cwd: gitDirectory, env: environmentFactory(), abortSignal, timeoutMs: 30000, maxOutputBytes: 1024,
  });
  if (ancestor.exitCode !== 0 || ancestor.timedOut || ancestor.error || ancestor.signal || ancestor.stdoutTruncated || ancestor.stderrTruncated)
    throw new HistoricalMigrationFailure("Historical artifact is no longer in integration history");
  const [exact, live] = await Promise.all([
    readExactExecutionPolicy(gitDirectory, commit, environmentFactory),
    readExactExecutionPolicy(gitDirectory, tip, environmentFactory),
  ]);
  const migration = exact.configuration?.migrationFinalization;
  if (migration?.mode !== "late_bound_serialized"
    || JSON.stringify(migration) !== JSON.stringify(live.configuration?.migrationFinalization)
    || postIntegrationPolicyDigest((await readPostIntegrationPolicy(gitDirectory, tip, environmentFactory)).policy) !== policyDigest)
    throw new HistoricalMigrationFailure("Historical migration policy changed or is not recoverable");
  if (!Array.isArray(migration.triggerPaths) || !Array.isArray(migration.artifactPaths))
    throw new HistoricalMigrationFailure("Historical migration input paths are missing");
  const commandInputs = [exact.configuration.postIntegration.command, exact.configuration.postIntegration.targetProbe]
    .flatMap((command) => {
      const cwd = command.cwd ?? ".";
      return [path.posix.join(cwd, "package.json"), ...command.args
        .filter((arg) => /\.(?:[cm]?js|ts)$/.test(arg) && !arg.startsWith("-"))
        .map((arg) => path.posix.dirname(path.posix.join(cwd, arg)))];
    });
  const protectedPaths = [...new Set([
    ".peach/execution.json",
    ...migration.triggerPaths, ...migration.artifactPaths,
    ...commandInputs,
  ])];
  if (protectedPaths.some((value) => typeof value !== "string" || !value || path.isAbsolute(value)
    || value.startsWith(":") || value.includes("\\") || value.split("/").includes("..")))
    throw new HistoricalMigrationFailure("Historical migration input paths are unsafe");
  const unchanged = await runBoundedProcess({
    executable: "git", args: ["--git-dir", gitDirectory, "diff", "--quiet", commit, tip, "--", ...protectedPaths],
    cwd: gitDirectory, env: environmentFactory(), abortSignal, timeoutMs: 30000, maxOutputBytes: 1024,
  });
  if (unchanged.exitCode !== 0 || unchanged.timedOut || unchanged.error || unchanged.signal || unchanged.stdoutTruncated || unchanged.stderrTruncated)
    throw new HistoricalMigrationFailure("Historical migration inputs changed after integration");
}
// A separate external-target lease, not a long-held workspace identity transaction.
function withTargetLease(directory, identity, operation) {
  const abort = new AbortController();
  return Effect.runPromise(Effect.acquireUseRelease(
    Effect.tryPromise(() => lockfile.lock(path.join(directory, `target-${identity}`), {
      realpath: false, stale: 120_000, update: 10_000,
      retries: { retries: 200, minTimeout: 25, maxTimeout: 100 },
      onCompromised: () => abort.abort(),
    })),
    () => Effect.tryPromise({
      try: () => operation(abort.signal),
      catch: (cause) => cause instanceof Error ? cause : new Error("Post-integration operation failed"),
    }),
    (release) => Effect.promise(release),
  ));
}

// The original v1 normalizer omitted approvalMode. Reuse only a completed,
// explicitly approved legacy receipt for this exact operation, never its grant
// for unfinished work. Returning the original record preserves its audit key.
function completedLegacyReceipt(previous, gitDirectory, commit, policy) {
  if (previous.status !== "complete" || previous.ok !== true || previous.approved !== true
    || previous.attempt < 1 || previous.integratedCommitSha !== commit || previous.target !== policy.target) return false;
  const legacyPolicy = {
    version: policy.version,
    target: policy.target,
    idempotency: policy.idempotency,
    command: policy.command,
    targetProbe: policy.targetProbe,
    timeoutMs: policy.timeoutMs,
    environmentKeys: policy.environmentKeys,
  };
  const digest = createHash("sha256").update(JSON.stringify(legacyPolicy)).digest("hex");
  const key = createHash("sha256").update(JSON.stringify([gitDirectory, commit, digest, policy.target])).digest("hex");
  return previous.policyDigest === digest && previous.idempotencyKey === key;
}

async function readState(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (!value || typeof value !== "object" || !["approval_required", "running", "failed", "complete"].includes(value.status) || value.sourceIntegrated !== true || !Number.isInteger(value.attempt) || value.attempt < 0 || value.ok !== (value.status === "complete"))
      throw new Error("Invalid post-integration state");
    return value;
  } catch (error) {
    if (error.code === "ENOENT")
      return null;
    throw error;
  }
}
export async function finalizePostIntegration(input) {
  const commit = input.integratedCommitSha;
  const environmentFactory = input.environment ?? sanitizedProcessEnv;
  const { gitDirectory, policy } = await readPostIntegrationPolicy(input.gitDirectory, commit, environmentFactory);
  if (!policy) return { ok: true, sourceIntegrated: true, status: "not_declared", integratedCommitSha: commit };
  const policyDigest = postIntegrationPolicyDigest(policy);
  const identity = createHash("sha256").update(JSON.stringify([gitDirectory, commit, policyDigest, policy.target])).digest("hex");
  const stateKey = createHash("sha256").update(JSON.stringify([gitDirectory, commit])).digest("hex");
  const stateDirectory = input.stateDirectory ?? path.join(homedir(), ".pi", "agent", "workspace-state", "post-integration");
  const statePath = path.join(stateDirectory, `${stateKey}.json`);
  await mkdir(stateDirectory, { recursive: true, mode: 448 });
  const targetKey = createHash("sha256").update(JSON.stringify([gitDirectory, policy.target])).digest("hex");
  return withTargetLease(stateDirectory, targetKey, async (leaseSignal) => {
    const abortSignal = input.abortSignal ? AbortSignal.any([input.abortSignal, leaseSignal]) : leaseSignal;
    const previous = await readState(statePath);
    if (previous && (previous.integratedCommitSha !== commit || previous.policyDigest !== policyDigest || previous.target !== policy.target || previous.idempotencyKey !== identity)
      && !completedLegacyReceipt(previous, gitDirectory, commit, policy)) {
      throw new Error("Post-integration identity drift requires reconciliation");
    }
    if (previous?.status === "complete" || input.inspectOnly === true && previous)
      return previous;
    const evidence = { sourceIntegrated: true, integratedCommitSha: commit, policyDigest, target: policy.target, idempotencyKey: identity };
    const policyApproved = policy.approvalMode === "automatic-development";
    const humanApproved = exactPostIntegrationApproval(input.approval, commit, policyDigest, policy.target);
    const approved = policyApproved || input.approval === undefined && previous?.approved === true || humanApproved;
    if (!approved || input.inspectOnly === true) {
      const pending = {
        ...evidence,
        ok: false,
        status: "approval_required",
        attempt: previous?.attempt ?? 0,
        reason: "Explicit approval for this integrated artifact, policy and external target is required"
      };
      if (!previous || previous.status === "approval_required")
        await writeWorkspaceJson(statePath, pending);
      return pending;
    }
    const accepted = {
      ...evidence,
      approved: true,
      authorization: policyApproved ? "repository-policy" : previous?.authorization ?? "human"
    };
    const attempt = (previous?.attempt ?? 0) + 1;
    await writeWorkspaceJson(statePath, { ...accepted, ok: false, status: "running", attempt });
    let reason = "Integration tip changed before finalization";
    try {
      await historicalMigrationTip(input, gitDirectory, commit, policyDigest, environmentFactory, abortSignal);
      reason = "Exact source preparation failed";
      const complete = await withFinalizationSource(gitDirectory, commit, async (root) => {
        const environment = environmentFactory();
        for (const key of policy.environmentKeys) {
          if (process.env[key] !== undefined)
            environment[key] = process.env[key];
        }
        Object.assign(environment, { PEACH_FINALIZATION_COMMIT: commit, PEACH_FINALIZATION_KEY: identity, PEACH_FINALIZATION_TARGET: policy.target });
        reason = "External target could not be verified";
        const probe = await runBoundedProcess({
          executable: policy.targetProbe.executable,
          args: policy.targetProbe.args,
          cwd: await finalizationCwd(root, policy.targetProbe.cwd),
          env: environment, abortSignal,
          timeoutMs: 30000,
          maxOutputBytes: 16 * 1024
        });
        if (probe.exitCode !== 0 || probe.timedOut || probe.error || probe.signal || probe.stdoutTruncated || probe.stderrTruncated)
          throw new Error(reason);
        const target = JSON.parse(probe.stdout);
        if (!target || target.target !== policy.target)
          throw new Error(reason);
        reason = "Integration tip changed before external-state finalization";
        await historicalMigrationTip(input, gitDirectory, commit, policyDigest, environmentFactory, abortSignal);
        reason = "Finalization command failed or its outcome is unknown; retry with the same artifact key";
        const result = await runBoundedProcess({
          executable: policy.command.executable,
          args: policy.command.args,
          cwd: await finalizationCwd(root, policy.command.cwd),
          env: environment, abortSignal,
          timeoutMs: policy.timeoutMs,
          maxOutputBytes: 16 * 1024,
          redactOutput: () => "[post-integration command output withheld]"
        });
        if (result.exitCode !== 0 || result.timedOut || result.error || result.signal)
          throw new Error(reason);
        reason = "Integration tip changed during finalization; external outcome requires reconciliation";
        await historicalMigrationTip(input, gitDirectory, commit, policyDigest, environmentFactory, abortSignal);
        return { ...accepted, ok: true, status: "complete", attempt };
      }, environmentFactory, abortSignal);
      reason = "Finalization interrupted or external target lease lost; external outcome requires reconciliation";
      if (abortSignal.aborted) throw new Error(reason);
      reason = "External finalization succeeded but its local receipt could not be persisted; retry with the same key";
      await writeWorkspaceJson(statePath, complete);
      return complete;
    } catch (error) {
      if (error instanceof HistoricalMigrationFailure) reason = error.message;
      const failed = { ...accepted, ok: false, status: "failed", attempt, reason };
      await writeWorkspaceJson(statePath, failed);
      return failed;
    }
  });
}
