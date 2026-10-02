export function migrationCommandFailure(command: string, result: {
  exitCode?: number | null; code?: number; signal?: string | null;
  timedOut?: boolean; cancelled?: boolean; error?: string;
  stdout?: string; stderr?: string; stdoutTruncated?: boolean; stderrTruncated?: boolean; truncated?: boolean;
}, root: string, environment?: NodeJS.ProcessEnv, subject?: string): Error & { evidence: Record<string, unknown> };

export function redactMigrationOutput(value: string, root: string, environment?: NodeJS.ProcessEnv): string;
