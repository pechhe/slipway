export type VerificationCommand = { executable: string; args: string[]; cwd?: string; baseline?: unknown; concurrent?: boolean };
/** Declared order, with consecutive `concurrent` checks run together; outcomes keep declaration order. */
export function runVerificationStages<Check, Outcome>(checks: readonly Check[], verify: (check: Check, index: number) => Promise<Outcome>): Promise<Outcome[]>;
export type CapabilityDeclaration = {
  id: string;
  probe: VerificationCommand;
  onUnavailable: "continue";
  unavailableExitCodes: number[];
  unavailableStderrIncludes: string[];
};
export type VerificationDeclaration = VerificationCommand & { capability?: CapabilityDeclaration };
export type VerificationGap = {
  capability: string;
  command: string;
  reason: string;
  probeCommand?: string;
  probeExitCode?: number | null;
};
export type VerificationEvidence = {
  status: "passed" | "passed_with_gaps";
  passed: string[];
  gaps: VerificationGap[];
  policyDigest: string;
};
export function normalizeVerificationDeclaration(value: unknown, field?: string): VerificationDeclaration;
export function classifyCapabilityProbe(capability: CapabilityDeclaration, result: {
  code?: number; exitCode?: number | null; signal?: string | null; stderr?: string;
  timedOut?: boolean; cancelled?: boolean; error?: unknown;
}): { status: "available" } | { status: "unavailable" | "failed"; reason: string };
export function verificationGap(capability: CapabilityDeclaration, command: string, result: {
  code?: number; exitCode?: number | null;
}, reason: string): VerificationGap;
export function verificationEvidence(passed: string[], gaps: VerificationGap[], declarations: unknown): VerificationEvidence;
export function verificationReviewEvidence(evidence: VerificationEvidence): string[];

export function normalizeDeclaredVerification(value: unknown): VerificationDeclaration[];
