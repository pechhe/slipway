export const VERIFICATION_SLOT_ENV: "SLIPWAY_VERIFICATION_SLOT";
export function verificationSlotEnvironment(environment?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function withVerificationSlot<T>(
  operation: () => Promise<T>,
  options?: {
    env?: NodeJS.ProcessEnv;
    root?: string;
    /** The integration root this landing serializes on; omitted, the slot is machine-wide. */
    scope?: string;
    pollMs?: number;
    signal?: AbortSignal;
    /** This landing's name, shown to landings waiting behind it as `holder`. */
    label?: string;
    onWait?: (status: { ahead: number; holder: string | null }) => void;
  },
): Promise<T>;
