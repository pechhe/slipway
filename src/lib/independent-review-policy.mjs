import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { writeWorkspaceJson } from "./workspace-transaction.mjs";

export const INDEPENDENT_REVIEW_POLICY = "explicit-request-v1";
const stateHome = () => join(homedir(), ".pi", "agent", "workspace-state", "reviews");
const actor = (options) => options.requesterIdentity ?? `local-user:${process.getuid?.() ?? "current"}`;

function receiptPath(candidate, options) {
  if (!candidate.workspaceName || basename(candidate.workspaceName) !== candidate.workspaceName
    || [".", ".."].includes(candidate.workspaceName)) throw new Error("Invalid review workspace identity");
  return join(options.stateHome ?? stateHome(), `${candidate.workspaceName}.json`);
}

export function independentReviewCandidateDigest(candidate) {
  return createHash("sha256").update(JSON.stringify({
    policy: INDEPENDENT_REVIEW_POLICY,
    integrationRoot: resolve(candidate.integrationRoot),
    integrationBranch: candidate.integrationBranch,
    integrationBaseCommitSha: candidate.integrationBaseCommitSha,
    changeId: candidate.changeId,
    commitSha: candidate.commitSha,
    changedPaths: [...candidate.changedPaths].sort(),
    diff: candidate.diff.trim(),
    verification: candidate.verification,
  })).digest("hex");
}

async function readReceipt(candidate, options) {
  let value;
  try { value = JSON.parse(await readFile(receiptPath(candidate, options), "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Review state is unreadable; recover the preserved workspace instead of discarding its request", { cause: error });
  }
  // v1 had no reliable explicit-request provenance and could be risk-generated.
  // It is historical evidence, never authority to require or approve review.
  if (value?.version === 1) return null;
  if (value?.version !== 2 || value.policyVersion !== INDEPENDENT_REVIEW_POLICY
    || typeof value.requestActive !== "boolean" || !Array.isArray(value.events)
    || value.workspaceName !== candidate.workspaceName
    || value.integrationRoot !== resolve(candidate.integrationRoot)
    || value.integrationBranch !== candidate.integrationBranch
    || !["required", "pass", "findings", "unavailable", "waived"].includes(value.status)
    || (value.status === "pass" && (value.semanticReviewPerformed !== true || typeof value.reviewerSessionFile !== "string" || !value.reviewerSessionFile.trim()))) {
    throw new Error("Review state has incompatible identity or policy; recover the preserved workspace");
  }
  if (value.status === "waived") {
    const waiver = normalizeIndependentReviewWaiver(value.waiver);
    if (!waiver || waiver.candidateDigest !== value.candidateDigest || typeof value.waiver.by !== "string") throw new Error("Review waiver provenance is invalid");
  }
  return value;
}

async function writeReceipt(candidate, outcome, prior, options, requestActive, event) {
  const file = receiptPath(candidate, options);
  await mkdir(join(file, ".."), { recursive: true, mode: 0o700 });
  const receipt = {
    version: 2, policyVersion: INDEPENDENT_REVIEW_POLICY,
    workspaceName: candidate.workspaceName, workspacePath: resolve(candidate.workspacePath),
    integrationRoot: resolve(candidate.integrationRoot), integrationBranch: candidate.integrationBranch,
    integrationBaseCommitSha: candidate.integrationBaseCommitSha,
    changeId: candidate.changeId, commitSha: candidate.commitSha,
    requestActive, request: prior?.request ?? { by: actor(options), at: new Date().toISOString() },
    events: [...(prior?.events ?? []), { event, by: actor(options), at: new Date().toISOString(),
      candidateDigest: outcome.candidateDigest, ...(outcome.waiver ? { waiver: outcome.waiver } : {}) }].slice(-100),
    ...outcome,
  };
  await writeWorkspaceJson(file, receipt);
  return receipt;
}

export function normalizeIndependentReviewWaiver(value) {
  if (value == null) return undefined;
  if (typeof value !== "object" || Array.isArray(value) || value.humanApproved !== true
    || typeof value.reason !== "string" || !value.reason.trim() || value.reason.trim().length > 500
    || typeof value.candidateDigest !== "string" || !/^[a-f0-9]{64}$/.test(value.candidateDigest)) {
    throw new Error("Independent-review waiver requires explicit human approval, a reason, and the exact candidateDigest");
  }
  return { humanApproved: true, reason: value.reason.trim(), candidateDigest: value.candidateDigest };
}

function outcome(candidate, required, status) {
  return {
    policyVersion: INDEPENDENT_REVIEW_POLICY,
    decision: { review_required: required, reasons: required ? ["independent review explicitly requested"] : [] },
    candidateDigest: independentReviewCandidateDigest(candidate), status,
    semanticReviewPerformed: false,
  };
}

/** Called before verification, so a verification failure cannot forget a request.
 * The caller owns the native workspace writer. This function never acquires a
 * repository-wide lock or grants source/verification/integration authority. */
export async function recordIndependentReviewRequest(candidate, options = {}) {
  if (options.required !== undefined && typeof options.required !== "boolean") throw new Error("independentReview must be an explicit boolean");
  const waiver = normalizeIndependentReviewWaiver(options.waiver);
  if (waiver && options.required === true) throw new Error("Cannot request and waive independent review in the same submission");
  const prior = await readReceipt(candidate, options);
  if (options.required !== true || prior?.requestActive) return;
  await writeReceipt(candidate, outcome(candidate, true, "required"), null, options, true, "requested");
}

/** One policy shared by native Pi, Peach and its thin ChatGPT adapter. No risk
 * inference and no caller-submitted self-review receipt can satisfy this gate. */
export async function evaluateIndependentReview(candidate, options = {}) {
  await recordIndependentReviewRequest(candidate, options);
  const prior = await readReceipt(candidate, options);
  const required = prior?.requestActive === true;
  const result = outcome(candidate, required, required ? "required" : "not_requested");
  const waiver = normalizeIndependentReviewWaiver(options.waiver);
  if (waiver) {
    if (!required) throw new Error("Independent-review waiver requires an active explicit review request");
    if (waiver.candidateDigest !== result.candidateDigest) throw new Error("Independent-review waiver is stale for this candidate/base/verification");
    result.status = "waived";
    result.waiver = { ...waiver, by: actor(options), waivedAt: new Date().toISOString() };
    await writeReceipt(candidate, result, prior, options, true, "waived");
    return result;
  }
  if (!required) return result;
  if (prior.candidateDigest === result.candidateDigest
    && (prior.status === "pass" || (prior.status === "waived" && options.required !== true))) {
    return { ...result, status: prior.status, semanticReviewPerformed: prior.status === "pass",
      reviewerSessionFile: prior.reviewerSessionFile, ...(prior.waiver ? { waiver: prior.waiver } : {}), reused: true };
  }
  await writeReceipt(candidate, result, prior, options, true, "review_required");
  try {
    const review = await options.runReview?.(candidate);
    if (!review || !["pass", "findings"].includes(review.status)
      || typeof review.reviewerSessionFile !== "string" || !review.reviewerSessionFile.trim()
      || (options.implementationSessionFile && resolve(review.reviewerSessionFile) === resolve(options.implementationSessionFile))) {
      result.status = "unavailable";
      result.findings = review?.findings ?? "A fresh independent reviewer is unavailable or returned invalid evidence; retry the review-capable landing tool";
    } else {
      result.status = review.status;
      result.semanticReviewPerformed = true;
      result.reviewerSessionFile = review.reviewerSessionFile;
      if (review.findings) result.findings = review.findings;
    }
  } catch (error) {
    result.status = "unavailable";
    result.findings = error instanceof Error ? error.message : String(error);
  }
  await writeReceipt(candidate, result, prior, options, true, result.status);
  return result;
}

/** Only the landing authority calls this, after native exact-integration proof. */
export async function completeIndependentReview(candidate, options = {}) {
  const prior = await readReceipt(candidate, options);
  if (!prior?.requestActive) return;
  if (prior.candidateDigest !== independentReviewCandidateDigest(candidate)
    || !["pass", "waived"].includes(prior.status)) throw new Error("Cannot complete review for a different or unaccepted artifact");
  await writeWorkspaceJson(receiptPath(candidate, options), { ...prior, requestActive: false, integratedAt: new Date().toISOString() });
}
