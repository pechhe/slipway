/** The external-state idempotency key of one artifact, policy and target. */
export function artifactKey(gitDirectory: string, commit: string, policyDigest: string, target: string): string;
export function receiptPath(stateDirectory: string, gitDirectory: string, commit: string): string;
/** The key of one repository's external target: its lease and latest outcome. */
export function targetKeyOf(gitDirectory: string, target: string): string;
