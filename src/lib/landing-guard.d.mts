export function governedBranches(cwd: string): Promise<string[] | null>;
export function simpleCommands(line: string): string[][];
export function landingBypass(line: string, branches: readonly string[], releaseBranch?: string | null): string | null;
export function landingGuardDecision(input: unknown): Promise<{
  hookSpecificOutput: { hookEventName: "PreToolUse"; permissionDecision: "deny"; permissionDecisionReason: string };
} | null>;
