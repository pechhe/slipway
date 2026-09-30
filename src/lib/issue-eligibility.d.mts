export function assertIssueEligible(root: string, issueNumber: number | undefined, integrationBranch: string, run: (executable: string, args: string[], cwd: string) => Promise<string>): Promise<void>;

/** Read native workspace ownership at selection time; ExecutionTopology remains the frontier authority. */
export type IssueWorkspaceReader = (issueNumber: number) => Promise<{ name: string; lock?: unknown } | null>;
export function selectImplementationIssue(root: string, scopeNumber: number | undefined, integrationBranch: string, run: (executable: string, args: string[], cwd: string) => Promise<string>, readWorkspace?: IssueWorkspaceReader): Promise<number | undefined>;

export function assertCompletedIssueDelivered(root: string, issue: { number: number; state: string; state_reason?: string | null; repository_url?: string; html_url?: string }, repository: string, branch: string, run: (executable: string, args: string[], cwd: string) => Promise<string>): Promise<string>;
