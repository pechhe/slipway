import type { WorkspaceEntry } from "./peach-workspace.mjs";
export function readySpares(cwd: string): Promise<WorkspaceEntry[]>;
export function provisionSpare(cwd?: string): Promise<{ provisioned: boolean; reason?: string; workspacePath?: string }>;
export function claimSpare(cwd: string, name: string): Promise<{ root: string; name: string } | null>;
export function uniqueUntrackedMaterial(root: string, limit?: number): Promise<string[]>;
export function cleanupLandedWorkspace(cwd?: string): Promise<{ cleaned: boolean; reason?: string; paths?: string[] }>;
