export type WorkspaceTransactionState = {
  phase: "queued" | "acquired" | "released";
  key: string;
  operationId?: string;
  ownerOperationId?: string;
  blockedByOperationId?: string;
  queueWaitMs?: number;
  criticalSectionMs?: number;
};
export function withWorkspaceTransaction<T>(
  key: string,
  operation: () => Promise<T>,
  options?: {
    operationId?: string;
    onState?: (state: WorkspaceTransactionState) => void;
  },
): Promise<T>;
export function writeWorkspaceJson(file: string, value: unknown): Promise<void>;
