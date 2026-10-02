export function prepareWorkspaceDependencies(workspacePath: string, options?: { quiet?: boolean; recordInputs?: boolean; env?: NodeJS.ProcessEnv }): Promise<{
  state: "ready" | "not_required"; packageManager: string | null; installInputs: string | null;
}>;
