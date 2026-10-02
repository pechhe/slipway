import type { Schedule } from "effect";
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
  /** Landing context captured at queue time for a failure Issue. */
  description?: string;
  diffStat?: string | null;
  originatingIssue?: number | null;
  /** GitHub `owner/name`, or null when the repository has no GitHub remote. */
  repository?: string | null;
  issue?: PostLandIssue;
};
export type PostLandIssue = {
  status: "opened" | "not_opened";
  url?: string;
  reason?: string;
  /** For `not_opened`: whether the failure may succeed later (timeout, network, 5xx), so a later post-land run retries it. */
  transient?: boolean;
  /** For `not_opened`: invocations that have tried to open the Issue. */
  attempts?: number;
  link?: { status: "linked" | "not_linked"; originatingIssue: number; reason?: string };
};
export type PostLandLanding = Pick<PostLandRecord, "description" | "diffStat" | "originatingIssue" | "repository">;
export type GhRunner = (args: string[]) => Promise<string>;
export type PostLandIssueOptions = { gh?: GhRunner; schedule?: Schedule.Schedule<unknown, string> };
export function postLandRoot(): string;
export function startPostLandVerification(input: {
  integrationRoot: string; gitDirectory: string; base: string; commit: string; checks: PostLandCheck[];
  runner?: string[];
  env?: NodeJS.ProcessEnv;
  landing?: PostLandLanding;
}): Promise<PostLandRecord>;
export function latestPostLandResult(integrationRoot: string): Promise<PostLandRecord | null>;
export function describePostLandFailure(record: PostLandRecord | null): string | null;
export function runPostLandVerification(recordFile: string, env?: NodeJS.ProcessEnv, options?: PostLandIssueOptions): Promise<void>;
export function retryPostLandIssues(integrationRoot: string, env?: NodeJS.ProcessEnv, options?: PostLandIssueOptions, except?: string | null): Promise<void>;
