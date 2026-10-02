import type { VerificationDeclaration } from "./verification-policy.mjs";
import type { PostLandCheck } from "./post-land-verification.mjs";

export type MigrationCommand = { executable: string; args: string[]; cwd: string | null };
export type MigrationFinalizationPolicy = {
  mode: "late_bound_serialized";
  triggerPaths: string[];
  artifactPaths: string[];
  generate: MigrationCommand;
  verify: MigrationCommand;
};
/** A parsed version-1 policy: landing sections normalized, every other declaration kept as declared. */
export type ExecutionPolicy = {
  [key: string]: unknown;
  version: 1;
  integrationBranch?: string;
  remote: string | null;
  parallelExecution: boolean;
  requiredLocalVerification: VerificationDeclaration[];
  postLandVerification: PostLandCheck[];
  migrationFinalization: MigrationFinalizationPolicy | null;
  generatedPaths?: unknown;
  postIntegration?: unknown;
};
export type IntegrationBranchProbes = {
  originHead?: () => Promise<string | null>;
  exists: (branch: string) => Promise<boolean>;
};

export const EXECUTION_POLICY_PATH: "slipway.json";
export const LEGACY_EXECUTION_POLICY_PATH: ".peach/execution.json";
export const EXECUTION_POLICY_PATHS: readonly ["slipway.json", ".peach/execution.json"];
export function warnLegacyExecutionPolicy(location: string): void;
export function selectExecutionPolicyPath(exists: (path: string) => Promise<boolean>, location: string): Promise<string | null>;
export const SAFE_BRANCH: RegExp;
export const UNDECLARED_POLICY: Readonly<Pick<ExecutionPolicy, "requiredLocalVerification" | "postLandVerification" | "remote" | "parallelExecution" | "migrationFinalization">>;
export function parseExecutionPolicy(raw: string, path?: string): ExecutionPolicy;
export function readExecutionPolicy(root: string): Promise<ExecutionPolicy | null>;
export function readExecutionPolicyAtCommit(repo: string, revision: string): Promise<{ commitId: string; policy: ExecutionPolicy | null }>;
export function generatedPathMatchers(declared: unknown): RegExp[];
export function resolveIntegrationBranch(input: { declared?: string | null } & IntegrationBranchProbes): Promise<string | null>;
export function jjIntegrationProbes(repo: string): Required<IntegrationBranchProbes>;
export function readIntegrationPolicy(repo: string, options?: { hintRoot?: string }): Promise<{ integrationBranch: string; commitId: string; policy: ExecutionPolicy | null }>;
