/** Declarations of `slipway cutover`; see cutover.mjs. */
export const CLI_STUB: string;
export const LIBRARY_STUB: string;

/** Everything holding or about to take a lock or run in a slipway state directory, one line each. */
export function cutoverHolders(root?: string): Promise<string[]>;

export type CutoverResult =
  | { status: "refused"; holders: string[] }
  | { status: "ready"; holders: []; from: { state: string; mode: string }; to: { state: string; mode: string }; stubs: string[] }
  | { status: "already-cut-over"; marker: string; holders: []; reappeared?: string[] }
  | {
    status: "cut-over"; marker: string; holders: []; version: 1; cutoverAt: string;
    from: { state: string; mode: string }; to: { state: string; mode: string };
    state: string; mode: string; stubs: string[];
  };

/** Run the cutover, or with `check` only report whether it would run. */
export function cutover(options?: {
  check?: boolean;
  io?: { rename?: (from: string, to: string) => Promise<void> };
}): Promise<CutoverResult>;
