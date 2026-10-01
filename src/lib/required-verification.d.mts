import type { BoundedProcessResult } from "./bounded-process.mjs";
import type { VerificationDeclaration, VerificationEvidence } from "./verification-policy.mjs";

export type RequiredVerificationFailureEvidence = {
  kind: "required_local_verification";
  outcome: "nonzero_exit" | "timeout" | "cancelled" | "signal" | "spawn_failure";
  checkIndex: number;
  command: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  cancelled: boolean;
  stdoutTail: string;
  stderrTail: string;
  stdoutTailTruncated: boolean;
  stderrTailTruncated: boolean;
  outputSha256: string;
  finishedAt: string;
  error?: string;
};

export class RequiredVerificationError extends Error {
  readonly evidence: RequiredVerificationFailureEvidence;
  constructor(evidence: RequiredVerificationFailureEvidence, summary?: string);
}

export function runRequiredVerification(input: {
  root: string;
  checks: readonly unknown[];
  environment?: () => NodeJS.ProcessEnv;
  onProgress?: (line: string) => void;
  acceptFailure?: (check: VerificationDeclaration, failure: BoundedProcessResult, environment: NodeJS.ProcessEnv) => Promise<string | null>;
  slot?: { label?: string; onWait?: (state: { ahead: number; holder: string | null }) => void };
}): Promise<VerificationEvidence>;
