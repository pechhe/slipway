export const TEARDOWN_TIMEOUT_MS: number;
export function runWorkspaceTeardown(
  integrationRoot: string,
  workspace: { name: string; root?: string },
  options?: { timeoutMs?: number },
): Promise<{ ran: boolean; ok: boolean }>;
