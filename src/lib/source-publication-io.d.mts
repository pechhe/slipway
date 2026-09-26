import type { BoundedProcessResult } from "./bounded-process.mjs";

export const EXACT_COMMIT: RegExp;
export function publicationDigest(value: unknown): string;
export function publicationEnvironment(): NodeJS.ProcessEnv;
export class PublicationFailure extends Error {
  code: string;
  constructor(code: string, message: string);
}
export function publicationIO(gitDirectory: string, environment: () => NodeJS.ProcessEnv, abortSignal?: AbortSignal): {
  run(args: string[], accepted?: number[], limit?: number): Promise<BoundedProcessResult>;
  destination(remote: string): Promise<{ url: string; digest: string }>;
  ancestor(older: string, newer: string): Promise<boolean>;
  remoteHead(url: string, ref: string): Promise<string>;
  outgoing(from: string, target: string): Promise<{ outgoingCount: number; outgoingDigest: string }>;
  push(url: string, ref: string, target: string): Promise<BoundedProcessResult>;
};
