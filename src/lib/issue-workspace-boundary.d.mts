type Run = (executable: string, args: string[], cwd: string) => Promise<string>;
export function assertIssueWorkspaceBoundary(root: string, issueNumber: number | undefined, workspaceName: string, run: Run, options?: { existingBinding?: boolean; stateRoot?: string }): Promise<void>;
export function assertWorkspaceIssueBoundary(workspaceName: string, run: Run): Promise<void>;
