import type { WorkspaceEntry } from "./peach-workspace.mjs";
export function readySpares(cwd: string): Promise<WorkspaceEntry[]>;
export function provisionSpare(cwd?: string): Promise<{ provisioned: boolean; reason?: string; workspacePath?: string }>;
export function claimSpare(cwd: string, name: string): Promise<{ root: string; name: string } | null>;
export function generatedPathMatchers(declared: unknown): RegExp[];
export function uniqueUntrackedMaterial(root: string, limit?: number, generated?: RegExp[]): Promise<string[]>;
export function retainedWorkspaceMaterial(root: string, integrationRoot: string, limit?: number): Promise<string[]>;
export function describeRetention(result: { reason?: string; paths?: string[] } | null | undefined): string;
export function cleanupLandedWorkspace(cwd?: string): Promise<{ cleaned: boolean; reason?: string; paths?: string[] }>;
