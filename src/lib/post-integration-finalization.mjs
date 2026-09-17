import { Effect } from "effect";
import lockfile from "proper-lockfile";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { writeWorkspaceJson } from "./workspace-transaction.mjs";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.mjs";
import { exactPostIntegrationApproval, postIntegrationPolicyDigest } from "./post-integration-policy.mjs";
import { finalizationCwd, readPostIntegrationPolicy, withFinalizationSource } from "./post-integration-source.mjs";
// A separate external-target lease, not a long-held workspace identity transaction.
function withTargetLease(directory, identity, operation) {
  const abort = new AbortController();
  return Effect.runPromise(Effect.acquireUseRelease(
    Effect.tryPromise(() => lockfile.lock(path.join(directory, `target-${identity}`), {
      realpath: false, stale: 120_000, update: 10_000,
      retries: { retries: 200, minTimeout: 25, maxTimeout: 100 },
      onCompromised: () => abort.abort(),
    })),
    () => Effect.tryPromise(() => operation(abort.signal)),
    (release) => Effect.promise(release),
  ));
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
    if (previous && (previous.integratedCommitSha !== commit || previous.policyDigest !== policyDigest || previous.target !== policy.target || previous.idempotencyKey !== identity))
      throw new Error("Post-integration identity drift requires reconciliation");
    if (previous?.status === "complete" || input.inspectOnly === true && previous)
      return previous;
    const evidence = { sourceIntegrated: true, integratedCommitSha: commit, policyDigest, target: policy.target, idempotencyKey: identity };
    const approved = input.approval === undefined && previous?.approved === true || exactPostIntegrationApproval(input.approval, commit, policyDigest, policy.target);
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
    const accepted = { ...evidence, approved: true };
    const attempt = (previous?.attempt ?? 0) + 1;
    await writeWorkspaceJson(statePath, { ...accepted, ok: false, status: "running", attempt });
    let reason = "Integration tip changed before finalization";
    try {
      if ((await input.readIntegrationTip()).trim() !== commit)
        throw new Error(reason);
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
        if ((await input.readIntegrationTip()).trim() !== commit)
          throw new Error(reason);
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
        if ((await input.readIntegrationTip()).trim() !== commit)
          throw new Error(reason);
        return { ...accepted, ok: true, status: "complete", attempt };
      }, environmentFactory, abortSignal);
      reason = "Finalization interrupted or external target lease lost; external outcome requires reconciliation";
      if (abortSignal.aborted) throw new Error(reason);
      reason = "External finalization succeeded but its local receipt could not be persisted; retry with the same key";
      await writeWorkspaceJson(statePath, complete);
      return complete;
    } catch {
      const failed = { ...accepted, ok: false, status: "failed", attempt, reason };
      await writeWorkspaceJson(statePath, failed);
      return failed;
    }
  });
}
