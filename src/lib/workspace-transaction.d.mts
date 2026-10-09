/** With `wait: false`, a held transaction rejects at once with code `ELOCKED`; with `waitMs`, after waiting at most that long. */
export function withWorkspaceTransaction<T>(key: string, operation: () => Promise<T>, options?: { wait?: boolean; waitMs?: number }): Promise<T>;
export function writeWorkspaceJson(file: string, value: unknown): Promise<void>;
