/** The workspace's install-input fingerprint at `@`, or null when it cannot be computed exactly. `snapshot: false` never snapshots the working copy. */
export function installInputFingerprint(workspacePath: string, options?: { snapshot?: boolean }): Promise<string | null>;
