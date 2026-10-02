import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { installInputFingerprint } from "./install-inputs.mjs";
import { runWorkspaceCommand as run } from "./workspace-command.mjs";

/** Package-manager installation is the standalone Pi readiness authority. It is
 *  intentionally workspace-local and lockfile-frozen: package managers may reuse
 *  their immutable caches, but JJ workspaces never share mutable node_modules. */
async function workspaceDependencyCommand(workspacePath) {
  const raw = await readFile(join(workspacePath, "package.json"), "utf8").catch(() => null);
  if (!raw) return null;
  const packageManager = JSON.parse(raw).packageManager;
  if (typeof packageManager !== "string") {
    throw new Error(`Workspace dependency provisioning requires a declared packageManager in ${workspacePath}.`);
  }
  if (packageManager === "bun" || packageManager.startsWith("bun@")) {
    return {
      command: "bun",
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--backend=clonefile"],
    };
  }
  if (packageManager === "pnpm" || packageManager.startsWith("pnpm@")) {
    return {
      command: "pnpm",
      args: ["install", "--frozen-lockfile", "--prefer-offline", "--package-import-method=clone"],
    };
  }
  if (packageManager === "npm" || packageManager.startsWith("npm@")) {
    return { command: "npm", args: ["ci", "--prefer-offline"] };
  }
  throw new Error(`Workspace dependency provisioning does not support package manager '${packageManager}'.`);
}

/**
 * Install the workspace's dependencies. With `recordInputs`, the result also
 * carries the install-input fingerprint (see install-inputs.mjs) of the tree it
 * installed, or null when that tree is unknown or the install changed it.
 */
export async function prepareWorkspaceDependencies(workspacePath, options = {}) {
  const inputs = options.recordInputs ? await installInputFingerprint(workspacePath) : null;
  const dependencyCommand = await workspaceDependencyCommand(workspacePath);
  if (!dependencyCommand) return { state: "not_required", packageManager: null, installInputs: inputs };
  if (!options.quiet) console.log(`[deps] ${dependencyCommand.command} install in ${basename(workspacePath)}...`);
  // Installation is not a landing command: it keeps the user's environment and a longer deadline.
  const result = await run(dependencyCommand.command, dependencyCommand.args,
    { cwd: workspacePath, inherit: !options.quiet, env: options.env ?? process.env, timeoutMs: 30 * 60_000 });
  if (result.code !== 0) {
    throw new Error(
      `Dependency installation failed in ${workspacePath}; fix it before starting Pi here.`,
    );
  }
  const installed = inputs && await installInputFingerprint(workspacePath);
  return { state: "ready", packageManager: dependencyCommand.command, installInputs: installed === inputs ? inputs : null };
}
