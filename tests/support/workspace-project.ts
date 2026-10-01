import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

// Workspace fixtures create checkouts and state under `homedir()`. Under the real
// HOME they leak into ~/.pi and race live sessions, so a runner that skipped the
// hermetic setup (scripts/vitest-hermetic-env.mjs) fails here before any test runs.
if (homedir() === userInfo().homedir) {
  throw new Error("Workspace fixtures need a disposable HOME; run them through `vp test` or scripts/with-hermetic-home.mjs");
}

export const jj = (cwd: string, args: string[]) => execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8" }).trim();

// A disposable project with a bare `origin`, landing policy and a verification
// check that records which checkout it verified.
export async function project(options: { ignore?: string; generatedPaths?: unknown; verify?: (verified: string) => string } = {}) {
  process.env.JJ_USER ??= "Fixture";
  process.env.JJ_EMAIL ??= "fixture@example.com";
  const root = await realpath(await mkdtemp(join(tmpdir(), "peach-rollover-")));
  const repo = join(root, "repo");
  const remote = join(root, "remote.git");
  const verified = join(root, "verified.log");
  await mkdir(join(repo, ".peach"), { recursive: true });
  const git = (args: string[], cwd = repo) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git(["init", "-q", "--bare", "-b", "main", remote], root);
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  await writeFile(join(repo, "README.md"), "fixture\n");
  if (options.ignore) await writeFile(join(repo, ".gitignore"), options.ignore);
  await writeFile(join(repo, ".peach", "execution.json"), JSON.stringify({
    version: 1, integrationBranch: "main",
    sourcePublication: { version: 1, mode: "required", remote: "origin" },
    requiredLocalVerification: [{ executable: "sh", args: ["-c", options.verify?.(verified) ?? `pwd >> ${JSON.stringify(verified)}`] }],
    ...(options.generatedPaths === undefined ? {} : { generatedPaths: options.generatedPaths }),
  }));
  git(["add", "."]);
  git(["commit", "-qm", "Initial"]);
  git(["remote", "add", "origin", remote]);
  git(["push", "-q", "origin", "main"]);
  jj(repo, ["git", "init", "--colocate"]);
  // Workspace commands do not see JJ_USER/JJ_EMAIL, so the author lives in repository config.
  jj(repo, ["config", "set", "--repo", "user.name", "Fixture"]);
  jj(repo, ["config", "set", "--repo", "user.email", "fixture@example.com"]);
  jj(repo, ["bookmark", "track", "main", "--remote", "origin"]);
  const remoteFile = (path: string) => execFileSync("git", ["--git-dir", remote, "show", `main:${path}`], { encoding: "utf8" });
  return { root, repo, remote, verified, remoteFile, dispose: () => rm(root, { recursive: true, force: true }) };
}
