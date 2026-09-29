import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import {
  activeWorkspaceLock,
  metadataPath,
  run,
  workspaceContext,
  workspaceContinuationState,
  workspaceMetadata,
} from "./peach-workspace.mjs";
import { archiveIntegratedWorkspaceEvidence, readIntegratedWorkspaceEvidence } from "./workspace-finalization.mjs";
import { withWorkspaceTransaction, writeWorkspaceJson } from "./workspace-transaction.mjs";

/**
 * Explicitly reopen a landed workspace for same-task follow-up. The landing
 * receipt stays untouched and is archived by exact artifact, so finalization of
 * that artifact remains available after a later re-landing. The working copy
 * restarts on the live integration bookmark; writer ownership is unchanged.
 */
export async function reopenLandedWorkspace(cwd = process.cwd()) {
  const context = await workspaceContext(cwd);
  if (!context || context.current.name === "default") {
    throw new Error("Reopen requires a landed isolated JJ workspace");
  }
  const name = context.current.name;
  return withWorkspaceTransaction(`writer:${name}`, async () => {
    const continuation = await workspaceContinuationState(context);
    if (continuation.kind === "recovery_required") {
      throw new Error(`Historical landing evidence requires explicit recovery before reopening (${continuation.reason})`);
    }
    if (continuation.kind !== "landed_source") {
      return { reopened: false, reason: continuation.kind, workspaceName: name, workspacePath: context.current.root };
    }
    const lock = await activeWorkspaceLock(name);
    if (lock && (lock.surface === "peach" || lock.ownerAgentRunId || lock.revoking
      || ![process.pid, process.ppid].includes(lock.pid))) {
      throw new Error(`jj:${name} has another live owner; reopen it from the owning Pi session (peach_workspace_reopen or /workspace-reopen)`);
    }
    const evidence = await readIntegratedWorkspaceEvidence(cwd, continuation.artifactCommitId);
    if (!evidence) throw new Error("Exact landed delivery evidence is missing");
    await archiveIntegratedWorkspaceEvidence(evidence.gitDirectory, evidence.state);
    const moved = await run("jj", ["--color=never", "new", context.integrationBranch], { cwd: context.current.root });
    if (moved.code !== 0) throw new Error(`Could not restart jj:${name} on ${context.integrationBranch}: ${moved.stderr.trim()}`);
    const base = await run("jj", ["--color=never", "--ignore-working-copy", "log", "-r", context.integrationBranch,
      "--no-graph", "-T", "commit_id"], { cwd: context.current.root });
    const path = metadataPath(name);
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const reopenedAt = new Date().toISOString();
    await writeWorkspaceJson(path, {
      ...(await workspaceMetadata(name)),
      version: 1,
      workspaceName: name,
      workspacePath: context.current.root,
      integrationRoot: context.integration.root,
      reopenedFromArtifactCommitId: continuation.artifactCommitId,
      reopenedAt,
    });
    return {
      reopened: true,
      workspaceName: name,
      workspacePath: context.current.root,
      landedArtifactCommitId: continuation.artifactCommitId,
      integrationBranch: context.integrationBranch,
      baseCommitId: base.stdout.trim(),
      reopenedAt,
    };
  });
}
