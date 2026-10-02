import type { GhRunner, PostLandIssue, PostLandRecord } from "./post-land-verification.mjs";

export function githubRepository(remoteList: string, preferred?: string | null): string | null;
export function originatingIssue(issueNumber: unknown, description: string | undefined): number | null;
export function postLandIssueTitle(record: PostLandRecord): string;
export function postLandIssueBody(record: PostLandRecord): string;
export function openPostLandIssue(record: PostLandRecord, options?: { env?: NodeJS.ProcessEnv; gh?: GhRunner }): Promise<PostLandIssue | undefined>;
export function linkPostLandIssue(record: PostLandRecord, options?: { env?: NodeJS.ProcessEnv; gh?: GhRunner }): Promise<PostLandIssue | undefined>;
