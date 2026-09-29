export function summarizeVerificationFailure(result: {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: string | null;
  timedOut?: boolean;
}): string;
