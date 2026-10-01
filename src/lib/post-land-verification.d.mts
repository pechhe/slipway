export type PostLandCheck = { executable: string; args: string[]; cwd?: string };
export type PostLandRecord = {
  version: 1;
  status: "queued" | "running" | "passed" | "failed" | "error";
  integrationRoot: string;
  gitDirectory: string;
  base: string;
  commit: string;
  checks: PostLandCheck[];
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  log: string;
  failed?: { command: string; exitCode: number | string; tail: string };
  reason?: string;
};
export function postLandRoot(): string;
export function startPostLandVerification(input: {
  integrationRoot: string; gitDirectory: string; base: string; commit: string; checks: PostLandCheck[];
  runner?: string[];
  env?: NodeJS.ProcessEnv;
}): Promise<PostLandRecord>;
export function latestPostLandResult(integrationRoot: string): Promise<PostLandRecord | null>;
export function describePostLandFailure(record: PostLandRecord | null): string | null;
export function runPostLandVerification(recordFile: string, env?: NodeJS.ProcessEnv): Promise<void>;
