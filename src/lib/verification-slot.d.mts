export const VERIFICATION_SLOT_ENV: "PEACH_VERIFICATION_SLOT";
export function verificationSlotEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function withVerificationSlot<T>(
  operation: () => Promise<T>,
  options?: {
    env?: NodeJS.ProcessEnv;
    root?: string;
    pollMs?: number;
    signal?: AbortSignal;
    onWait?: () => void;
  },
): Promise<T>;
