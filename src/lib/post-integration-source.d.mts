type Environment = () => NodeJS.ProcessEnv;
export function finalizationGit(gitDirectory: string, args: string[], environment?: Environment): Promise<string>;
export function withFinalizationSource<T>(gitDirectory: string, commit: string, operation: (root: string) => Promise<T>, environment?: Environment, abortSignal?: AbortSignal): Promise<T>;
export function finalizationCwd(root: string, relative: string): Promise<string>;
export function readPostIntegrationPolicy(gitDirectory: string, commit: string, environment?: Environment): Promise<{ gitDirectory: string; policy: import("./post-integration-policy.mjs").PostIntegrationPolicy | null }>;
