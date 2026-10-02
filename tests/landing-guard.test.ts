import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vite-plus/test";
import { landingBypass, landingGuardDecision } from "../src/lib/landing-guard.mjs";

const branches = ["master"];

test("commands that publish or move the integration branch are refused", () => {
  for (const line of [
    "git push",
    "git push origin",
    "git push origin master",
    "git push origin HEAD:refs/heads/master",
    "git -C ../repo push --force origin +master",
    "git push --all origin",
    "jj git push",
    "jj --repository ../repo git push",
    "jj git push --tracked",
    "jj git push -b master",
    "jj git push --bookmark=master",
    "jj bookmark set master -r @",
    "jj b s master -r @-",
    "jj bookmark move master --to @",
    "git update-ref refs/heads/master HEAD",
    "git branch -f master HEAD",
    "gh pr merge 12 --squash",
    "cd ../repo && git push",
    "FOO=1 jj git push",
    "echo $(git push)",
    "bun run check; jj git push",
  ]) assert.ok(landingBypass(line, branches), line);
});

test("ordinary work and feature-branch publication are allowed", () => {
  for (const line of [
    "git status",
    "git log --oneline master",
    "jj new master",
    "jj rebase -d master",
    "jj describe -m 'git push later'",
    "echo \"jj git push\"",
    "git push origin feature/login",
    "jj git push -b feature/login",
    "jj git push -c @-",
    "jj bookmark set feature/login -r @",
    "jj bookmark list",
    "peach-workspace land",
    "slipway land",
    "gh pr create --fill",
    "gh pr view 12",
  ]) assert.equal(landingBypass(line, branches), null, line);
});

test("slipway.json governs the guard and the retired path beside it is ignored", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slipway-landing-guard-"));
  try {
    const neutral = path.join(root, "neutral");
    const both = path.join(root, "both");
    await mkdir(path.join(both, ".peach"), { recursive: true });
    await mkdir(neutral, { recursive: true });
    await writeFile(path.join(neutral, "slipway.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    await writeFile(path.join(both, "slipway.json"), JSON.stringify({ version: 1, integrationBranch: "trunk" }));
    await writeFile(path.join(both, ".peach", "execution.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    const push = (cwd: string, branch: string) => landingGuardDecision({ tool_name: "Bash", cwd, tool_input: { command: `jj git push -b ${branch}` } });
    assert.equal((await push(neutral, "develop"))?.hookSpecificOutput.permissionDecision, "deny");
    assert.equal((await push(both, "trunk"))?.hookSpecificOutput.permissionDecision, "deny");
    assert.equal(await push(both, "develop"), null, "the retired file is ignored once slipway.json exists");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a directory with only the retired path still guards (fail closed) and the denial names slipway.json", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slipway-landing-guard-retired-"));
  try {
    await mkdir(path.join(root, ".peach"), { recursive: true });
    await writeFile(path.join(root, ".peach", "execution.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    const push = (branch: string) => landingGuardDecision({ tool_name: "Bash", cwd: root, tool_input: { command: `jj git push -b ${branch}` } });
    for (const branch of ["develop", "main", "master"]) {
      const denied = await push(branch);
      assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny", branch);
      assert.match(denied!.hookSpecificOutput.permissionDecisionReason, /slipway land.*no longer read.*rename it to slipway\.json/);
    }
    assert.equal(await push("feature"), null, "feature bookmarks stay pushable");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the hook decision applies only to Bash in a governed repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "slipway-landing-guard-"));
  try {
    const governed = path.join(root, "governed", "nested");
    await mkdir(governed, { recursive: true });
    await writeFile(path.join(root, "governed", "slipway.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    const push = (cwd: string, command: string) => landingGuardDecision({ tool_name: "Bash", cwd, tool_input: { command } });
    const denied = await push(governed, "jj git push -b develop");
    assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied!.hookSpecificOutput.permissionDecisionReason, /slipway land/);
    assert.equal(await push(governed, "jj git push -b master"), null, "only the declared integration branch is guarded");
    assert.equal(await push(root, "git push"), null, "an ungoverned repository is untouched");
    assert.equal(await landingGuardDecision({ tool_name: "Read", cwd: governed, tool_input: { file_path: "x" } }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
