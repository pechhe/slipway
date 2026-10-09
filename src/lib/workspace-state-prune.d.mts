/** Remove machine-local state whose workspace no longer exists and dead verification-slot records; returns the removed names. Never throws. */
export function pruneWorkspaceState(): Promise<string[]>;
