export type VerificationCommand = { executable: string; args: string[]; cwd?: string; baseline?: unknown };
export type CapabilityDeclaration = {
  id: string;
  probe: VerificationCommand;
  onUnavailable: "continue";
  unavailableExitCodes: number[];
  unavailableStderrIncludes: string[];
};
export type VerificationDeclaration = VerificationCommand & { capability?: CapabilityDeclaration };
export type VerificationGap = { capability: string; command: string; reason: string };
export type VerificationEvidence = {
  status: "passed" | "passed_with_gaps";
  passed: string[];
  gaps: VerificationGap[];
  policyDigest: string;
};
export function normalizeVerificationDeclaration(value: unknown, field?: string): VerificationDeclaration;
export function classifyCapabilityProbe(capability: CapabilityDeclaration, result: {
  code?: number; exitCode?: number | null; signal?: string | null; stderr?: string;
  timedOut?: boolean; error?: unknown;
}): { status: "available" } | { status: "unavailable" | "failed"; reason: string };
export function verificationEvidence(passed: string[], gaps: VerificationGap[], declarations: unknown): VerificationEvidence;
export function verificationReviewEvidence(evidence: VerificationEvidence): string[];
