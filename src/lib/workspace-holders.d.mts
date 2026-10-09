export type ProcessWorkingDirectory = { pid: number; command: string; cwd: string };
export function processAlive(pid: unknown): boolean;
export function within(path: string, root: string): boolean;
export function processWorkingDirectories(): Promise<ProcessWorkingDirectory[] | null>;
export function callerPids(pid?: number): Promise<Set<number>>;
export function workspaceHolders(root: string, options?: { processes?: ProcessWorkingDirectory[] | null; ignore?: Set<number> }): Promise<ProcessWorkingDirectory[] | null>;
export function describeHolders(holders: ProcessWorkingDirectory[]): string;
