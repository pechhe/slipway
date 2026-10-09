import type { WorkspaceEntry } from "./workspace-jj.mjs";
export function readySpares(cwd: string): Promise<WorkspaceEntry[]>;
/** Add one spare, up to the declared `spares`; `reason` is `spare-exists` (pool full), `pool-disabled` or `not-jj` when none was added. */
export function provisionSpare(cwd?: string): Promise<{ provisioned: boolean; reason?: string; workspacePath?: string; name?: string }>;
/** Install a workspace's dependencies, cloning `node_modules` first from a spare or the primary checkout with identical install inputs. */
export function installSeededDependencies(integrationRoot: string, workspacePath: string, options?: { quiet?: boolean; recordInputs?: boolean; env?: NodeJS.ProcessEnv }): ReturnType<typeof import("./workspace-dependencies.mjs").prepareWorkspaceDependencies>;
/** A claimed spare's provisioned dependencies, reused because its install inputs are unchanged. */
export interface ReusedDependencies {
  state: "ready" | "not_required";
  packageManager: string | null;
  installInputs: string;
  reused: true;
}
export function claimSpare(cwd: string, name: string): Promise<{ root: string; name: string; dependencies: ReusedDependencies | null } | null>;
/** Start a detached, `nice`d `provisionSpare` for the repository of `cwd`; resolves once the child has spawned. */
export function startSpareRefill(
  cwd?: string,
  options?: { command?: string[] },
): Promise<{ started: boolean; pid?: number; logPath?: string; reason?: string }>;
