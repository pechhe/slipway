import type { PostReleaseOutcome } from "./release.mjs";

export function postReleaseRetry(candidate: string): string;
export function pendingPostRelease(root: string, candidate: string): Promise<PostReleaseOutcome | null>;
export function runPostRelease(input: {
  root: string;
  /** The step runs in the exact source of this local branch, read under the target lease. */
  integrationBranch: string;
  candidate: string;
  merge: string;
  onlyIfPending?: boolean;
  onProgress?: (line: string) => void;
}): Promise<PostReleaseOutcome | null>;
