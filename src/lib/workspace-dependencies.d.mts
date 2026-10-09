export function prepareWorkspaceDependencies(workspacePath: string, options?: {
  quiet?: boolean; recordInputs?: boolean; env?: NodeJS.ProcessEnv;
  /** Roots whose `node_modules` may seed this install, given the workspace's install-input fingerprint. */
  seedFrom?: (installInputs: string) => Promise<string[]> | string[];
}): Promise<{
  state: "ready" | "not_required"; packageManager: string | null; installInputs: string | null; seeded?: true;
}>;
