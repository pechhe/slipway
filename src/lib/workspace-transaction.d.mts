/** With `wait: false`, a held transaction rejects at once with code `ELOCKED`. */
export function withWorkspaceTransaction<T>(key: string, operation: () => Promise<T>, options?: { wait?: boolean }): Promise<T>;
export function writeWorkspaceJson(file: string, value: unknown): Promise<void>;
