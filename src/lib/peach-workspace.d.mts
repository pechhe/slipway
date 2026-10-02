/** Declarations of the landing tool's public entry; see peach-workspace.mjs. */

// Workspaces: context, assignment, state and housekeeping (launcher, extension, CLI, hooks, desktop).
export { explicitIssueNumber, projectPrefix, revisionFacts, workspaceContext, workspaceHasUnintegratedWork } from "./workspace-jj.mjs";
export {
  assertWorkspaceMutationAllowed, attachWorkspaceIssue, findWorkspace, inspectWorkspace, inspectWorkspaces, landingStatePaths,
  listWorkspaces, readLandingState, readWorkspaceMode, renameWorkspace, workspaceContinuationState, writeWorkspaceMode,
} from "./workspace-state.mjs";
export { createWorkspace, findIssueWorkspace, recoverIssueWorkspace } from "./workspace-create.mjs";
export {
  cleanupLandedWorkspace, describeRetention, provisionSpare, readySpares, removeWorkspace, retainedWorkspaceMaterial,
  retireWorkspace, startSpareRefill,
} from "./workspace-lifecycle.mjs";
export { pruneEmptyWorkspaces, sweepDisposableWorkspaces } from "./workspace-sweep.mjs";
export { withWorkspaceTransaction } from "./workspace-transaction.mjs";
export { acquirePrimaryWriter, activePrimaryWriter, releasePrimaryWriter } from "./primary-checkout-writer.mjs";
export { LANDED_WORKSPACE_REFUSAL, assertWorkspaceNotRetired, cleanupRetentionReason, workspaceContinuationDisposition } from "./workspace-delivery-lifecycle.mjs";
export { assertCompletedIssueDelivered, selectImplementationIssue } from "./issue-eligibility.mjs";

// Landing and its verification (CLI, extension, desktop delivery).
export { assertWorkspaceDelivered, landWorkspace, prepareWorkspaceContinuation } from "./workspace-landing.mjs";
export { landingPreview } from "./landing-steps.mjs";
export { RequiredVerificationError, runRequiredVerification } from "./required-verification.mjs";
export { classifyCapabilityProbe, normalizeDeclaredVerification, normalizeVerificationDeclaration } from "./verification-policy.mjs";
export { redactVerificationOutput } from "./verification-failure.mjs";
export { latestPostLandResult, runPostLandVerification } from "./post-land-verification.mjs";

// Repository policy and post-integration finalization (desktop, peach-pi scripts).
export { parseExecutionPolicy, readExecutionPolicy, readIntegrationPolicy, resolveIntegrationBranch } from "./execution-policy.mjs";
export { declaredPublicationRemote } from "./source-publication-policy.mjs";
export { postIntegrationPolicy } from "./post-integration-policy.mjs";
export { SourcePreparationFailure, finalizationGit, withFinalizationSource } from "./post-integration-source.mjs";
export { finalizePostIntegration } from "./post-integration-finalization.mjs";

// Process and text utilities the desktop shares with the closure.
export { landingCommandEnvironment } from "./workspace-command.mjs";
export { redactAndBoundProcessOutput, runBoundedProcess, sanitizedProcessEnv, setProcessBroker } from "./bounded-process.mjs";
export { truncateUtf8 } from "./utf8.mjs";

// Types of the entries above.
export type { RevisionFacts, WorkspaceContext, WorkspaceEntry, WorkspaceMetadata } from "./workspace-jj.mjs";
export type { CreatedWorkspace, WorkspaceCreationHooks } from "./workspace-create.mjs";
export type { RetirementHooks } from "./workspace-lifecycle.mjs";
export type { WorkspaceContinuationDisposition } from "./workspace-delivery-lifecycle.mjs";
export type { LandingAdapter, LandingPublication, LandingRevision, LandingTail, LandingTailOptions } from "./landing-steps.mjs";
export type { RequiredVerificationFailureEvidence } from "./required-verification.mjs";
export type { VerificationEvidence } from "./verification-policy.mjs";
export type { ExecutionPolicy } from "./execution-policy.mjs";
export type { PostIntegrationInput, PostIntegrationResult } from "./post-integration-finalization.mjs";
export type { BoundedProcessRequest, BoundedProcessResult, ProcessBroker } from "./bounded-process.mjs";
