export type WorkspaceCommandResult = {
  code: number;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  truncated: boolean;
};
export function landingCommandEnvironment(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function runWorkspaceCommand(
  command: string,
  args: readonly string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; inherit?: boolean },
): Promise<WorkspaceCommandResult>;
