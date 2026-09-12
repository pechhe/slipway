export function assertIssueEligible(root: string, issueNumber: number | undefined, integrationBranch: string, run: (executable: string, args: string[], cwd: string) => Promise<string>): Promise<void>;

export function selectImplementationIssue(root: string, scopeNumber: number | undefined, integrationBranch: string, run: (executable: string, args: string[], cwd: string) => Promise<string>): Promise<number | undefined>;

export function assertIssueReconciled(root: string, issueNumber: number | undefined, commit: string, run: (executable: string, args: string[], cwd: string) => Promise<string>): Promise<void>;

export function issueHasChildDeliveryUnits(root: string, issueNumber: number | undefined, run: (executable: string, args: string[], cwd: string) => Promise<string>): Promise<boolean>;
