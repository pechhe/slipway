type Environment = () => NodeJS.ProcessEnv;
export class SourcePreparationFailure extends Error {}
export function finalizationGit(gitDirectory: string, args: string[], environment?: Environment): Promise<string>;
export function withFinalizationSource<T>(gitDirectory: string, commit: string, operation: (root: string) => Promise<T>, environment?: Environment, abortSignal?: AbortSignal): Promise<T>;
export function readExactExecutionPolicy(gitDirectory: string, commit: string, environment?: Environment): Promise<{ gitDirectory: string; configuration: import("./execution-policy.mjs").ExecutionPolicy | null }>;
export function readPostIntegrationPolicy(gitDirectory: string, commit: string, environment?: Environment): Promise<{ gitDirectory: string; policy: import("./post-integration-policy.mjs").PostIntegrationPolicy | null }>;
