export function governedBranches(cwd: string): Promise<string[] | null>;
export function simpleCommands(line: string): string[][];
export function landingBypass(line: string, branches: readonly string[]): string | null;
export function landingGuardDecision(input: unknown): Promise<{
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string };
} | null>;
