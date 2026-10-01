import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { test } from "vite-plus/test";
import { landWorkspace } from "../src/lib/peach-workspace.mjs";
import { describePostLandFailure, latestPostLandResult, postLandRoot, startPostLandVerification, type PostLandRecord } from "../src/lib/post-land-verification.mjs";

const jj = (cwd: string, args: string[]) =>
  execFileSync("jj", ["--color=never", ...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

// The declared check proves it ran against the exact landed source and range,
// then passes or fails as the landed value says.
const CHECK = [
  "const fs = require('node:fs');",
  "const value = fs.readFileSync('value.txt', 'utf8');",
  "fs.writeFileSync(process.env.EVIDENCE, JSON.stringify({ value, base: process.env.PEACH_POST_LAND_BASE, commit: process.env.PEACH_POST_LAND_COMMIT }));",
  "process.exit(value === 'broken' ? 3 : 0);",
].join("\n");

async function fixture() {
  process.env.JJ_USER ??= "Fixture";
  process.env.JJ_EMAIL ??= "fixture@example.com";
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "peach-post-land-")));
  const repo = path.join(root, "repo");
  const evidence = path.join(root, "evidence.json");
  await mkdir(path.join(repo, ".peach"), { recursive: true });
  const git = (args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Fixture"]);
  git(["config", "user.email", "fixture@example.com"]);
  await writeFile(path.join(repo, "value.txt"), "initial");
  await writeFile(path.join(repo, ".peach", "execution.json"), JSON.stringify({
    version: 1, integrationBranch: "main", requiredLocalVerification: [],
    postLandVerification: [{ executable: process.execPath, args: ["-e", CHECK] }],
  }));
  git(["add", "."]);
  git(["commit", "-qm", "Initial"]);
  jj(repo, ["git", "init", "--colocate"]);
  process.env.EVIDENCE = evidence;
  let count = 0;
  return {
    root, repo, evidence,
    /** Land `value` from a fresh workspace, as one delivery. */
    async land(value: string) {
      const workspace = path.join(root, `workspace-${++count}`);
      jj(repo, ["workspace", "add", "--name", `post-land-${path.basename(root)}-${count}`, "--revision", "main", workspace]);
      await writeFile(path.join(workspace, "value.txt"), value);
      jj(workspace, ["describe", "-m", `Set ${value}`]);
      const base = jj(repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]);
      return { base, landed: await landWorkspace(workspace, { onProgress: () => {} }) };
    },
  };
}

async function finished(repo: string, commit: string): Promise<PostLandRecord> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const record = await latestPostLandResult(repo);
    if (record?.commit === commit) return record;
    await sleep(50);
  }
  const root = postLandRoot();
  const log = await readFile(path.join(root, `${commit}.log`), "utf8").catch((error) => String(error));
  const record = await readFile(path.join(root, `${commit}.json`), "utf8").catch((error) => String(error));
  throw new Error(`Post-land run for ${commit} did not finish.\nRecord: ${record}\nLog: ${log}`);
}

test("a post-land run whose process died before recording a result is reported, not left queued", async () => {
  const commit = "d".repeat(40);
  const exited = execFileSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  await mkdir(postLandRoot(), { recursive: true });
  await writeFile(path.join(postLandRoot(), `${commit}.json`), JSON.stringify({
    version: 1, status: "queued", integrationRoot: "/repository", commit, checks: [],
    queuedAt: new Date().toISOString(), log: path.join(postLandRoot(), `${commit}.log`),
  }));
  await writeFile(path.join(postLandRoot(), `${commit}.pid`), exited);
  const record = await latestPostLandResult("/repository");
  assert.equal(record?.status, "error");
  assert.match(describePostLandFailure(record) ?? "", /exited before recording a result/);
});

test("a detached runner that cannot start is recorded as an error instead of failing the landing process", async () => {
  const commit = "e".repeat(40);
  await startPostLandVerification({
    integrationRoot: "/unstartable", gitDirectory: "/unstartable/.git", base: "f".repeat(40), commit, checks: [],
    runner: ["/nonexistent/peach-post-land-runner"],
  });
  const record = await finished("/unstartable", commit);
  assert.equal(record.status, "error");
  assert.match(record.reason ?? "", /could not start/);
});

test("landing starts declared post-land verification against the exact landed source, and the next landing reports its failure", async () => {
  const f = await fixture();
  try {
    const good = await f.land("good");
    assert.equal(good.landed.ok, true);
    assert.equal(good.landed.postLand?.status, "queued");
    assert.equal((await finished(f.repo, good.landed.artifact.commitId)).status, "passed");
    assert.deepEqual(JSON.parse(await readFile(f.evidence, "utf8")),
      { value: "good", base: good.base, commit: good.landed.artifact.commitId });

    const broken = await f.land("broken");
    assert.equal(broken.landed.ok, true, "background verification never blocks the landing");
    assert.equal(broken.landed.postLandWarning, undefined);
    const failure = await finished(f.repo, broken.landed.artifact.commitId);
    assert.equal(failure.status, "failed");
    assert.equal(failure.failed?.exitCode, 3);

    const next = await f.land("fixed");
    assert.match(next.landed.postLandWarning ?? "", new RegExp(`${broken.landed.artifact.commitId.slice(0, 12)} failed`));
    assert.equal((await finished(f.repo, next.landed.artifact.commitId)).status, "passed");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
}, 120_000);
