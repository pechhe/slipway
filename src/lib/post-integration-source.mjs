import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Effect } from "effect";
import { postIntegrationPolicy } from "./post-integration-policy.mjs";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.mjs";
export async function finalizationGit(gitDirectory, args, environment = sanitizedProcessEnv) {
  const result = await runBoundedProcess({
    executable: "git",
    args: ["--git-dir", gitDirectory, ...args],
    cwd: gitDirectory,
    env: environment(),
    timeoutMs: 30000,
    maxOutputBytes: 512 * 1024
  });
  if (result.exitCode !== 0 || result.timedOut || result.error || result.signal || result.stdoutTruncated || result.stderrTruncated) {
    throw new Error("Exact-revision source operation failed");
  }
  return result.stdout;
}
export function withFinalizationSource(gitDirectory, commit, operation, environment = sanitizedProcessEnv, abortSignal) {
  return Effect.runPromise(Effect.acquireUseRelease(Effect.tryPromise(() => mkdtemp(path.join(tmpdir(), "peach-post-integration-"))), (directory) => Effect.tryPromise(async () => {
    const root = path.join(directory, "source");
    const clone = await runBoundedProcess({
      executable: "git",
      args: ["-c", "core.hooksPath=/dev/null", "clone", "--shared", "--no-checkout", "--", gitDirectory, root],
      cwd: directory,
      env: environment(), abortSignal,
      timeoutMs: 60000,
      maxOutputBytes: 16 * 1024
    });
    if (clone.exitCode !== 0 || clone.timedOut || clone.error || clone.signal)
      throw new Error("Could not prepare exact-revision source view");
    const checkout = await runBoundedProcess({
      executable: "git",
      args: ["-c", "core.hooksPath=/dev/null", "checkout", "--detach", commit],
      cwd: root,
      env: environment(), abortSignal,
      timeoutMs: 60000,
      maxOutputBytes: 16 * 1024
    });
    if (checkout.exitCode !== 0 || checkout.timedOut || checkout.error || checkout.signal)
      throw new Error("Could not materialize exact integrated revision");
    const head = (await finalizationGit(path.join(root, ".git"), ["rev-parse", "HEAD"], environment)).trim();
    if (head !== commit)
      throw new Error("Source view does not match integrated revision");
    return operation(root);
  }), (directory) => Effect.promise(() => rm(directory, { recursive: true, force: true }))));
}
export async function finalizationCwd(root, relative) {
  const canonicalRoot = await realpath(root);
  const cwd = await realpath(path.join(root, relative));
  if (cwd !== canonicalRoot && !cwd.startsWith(`${canonicalRoot}${path.sep}`))
    throw new Error("Finalization cwd escapes exact source view");
  return cwd;
}


/** Read a policy from a proven object, never the caller's working files. No external effects. */
export async function readPostIntegrationPolicy(selectedGitDirectory, commit, environment = sanitizedProcessEnv) {
  if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit)) throw new Error("An exact commit is required");
  const selectedDirectory = await realpath(selectedGitDirectory);
  const commonDirectory = (await finalizationGit(selectedDirectory, ["rev-parse", "--git-common-dir"], environment)).trim();
  const gitDirectory = await realpath(path.resolve(selectedDirectory, commonDirectory));
  const resolved = (await finalizationGit(gitDirectory, ["rev-parse", `${commit}^{commit}`], environment)).trim();
  if (resolved !== commit) throw new Error("Commit identity changed");
  const listed = (await finalizationGit(gitDirectory, ["ls-tree", "--name-only", commit, "--", ".peach/execution.json"], environment)).trim();
  if (!listed) return { gitDirectory, policy: null };
  const configuration = JSON.parse(await finalizationGit(gitDirectory, ["show", `${commit}:.peach/execution.json`], environment));
  return { gitDirectory, policy: postIntegrationPolicy(configuration.postIntegration) };
}
