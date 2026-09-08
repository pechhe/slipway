import type { IndependentReviewCandidate, IndependentReviewOutcome, IndependentReviewWaiver } from "../independent-review.ts";
export const INDEPENDENT_REVIEW_POLICY: "explicit-request-v1";
export type ReviewPolicyOptions = {
  required?: boolean; waiver?: IndependentReviewWaiver; stateHome?: string;
  requesterIdentity?: string; implementationSessionFile?: string;
  runReview?: (candidate: IndependentReviewCandidate) => Promise<{ status: string; reviewerSessionFile?: string; findings?: string }>;
};
export function independentReviewCandidateDigest(candidate: IndependentReviewCandidate): string;
export function normalizeIndependentReviewWaiver(value: unknown): IndependentReviewWaiver | undefined;
export function recordIndependentReviewRequest(candidate: IndependentReviewCandidate, options?: ReviewPolicyOptions): Promise<void>;
export function evaluateIndependentReview(candidate: IndependentReviewCandidate, options?: ReviewPolicyOptions): Promise<IndependentReviewOutcome>;
export function completeIndependentReview(candidate: IndependentReviewCandidate, options?: ReviewPolicyOptions): Promise<void>;
