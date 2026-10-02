import type { GhRunner, PostLandIssue, PostLandIssueOptions, PostLandRecord } from "./post-land-verification.mjs";

export function githubRepository(remoteList: string, preferred?: string | null): string | null;
export function originatingIssue(issueNumber: unknown, description: string | undefined): number | null;
export function postLandIssueTitle(record: PostLandRecord): string;
export function postLandIssueBody(record: PostLandRecord): string;
export const MAX_ISSUE_ATTEMPTS: number;
export function transientIssueFailure(reason: string | undefined): boolean;
export function pendingIssueRetry(record: PostLandRecord | null | undefined): boolean;
export function openPostLandIssue(record: PostLandRecord, options?: { env?: NodeJS.ProcessEnv } & PostLandIssueOptions): Promise<PostLandIssue | undefined>;
export function linkPostLandIssue(record: PostLandRecord, options?: { env?: NodeJS.ProcessEnv; gh?: GhRunner }): Promise<PostLandIssue | undefined>;
export function referencesIssue(description: string | null | undefined, issueNumber: number): boolean;
export function withIssueTrailer(description: string, issueNumber: number | null | undefined, repository: string | null): string;
