export function linkSharedPaths(integrationRoot: string, workspaceRoot: string): Promise<Array<{ path: string; status: "linked" | "kept" | "failed" }>>;
