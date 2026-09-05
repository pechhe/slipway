export function withWorkspaceTransaction<T>(key: string, operation: () => Promise<T>): Promise<T>;
export function writeWorkspaceJson(file: string, value: unknown): Promise<void>;
