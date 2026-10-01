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
    "gh pr create --fill",
    "gh pr view 12",
  ]) assert.equal(landingBypass(line, branches), null, line);
});

test("the hook decision applies only to Bash in a governed repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "peach-landing-guard-"));
  try {
    const governed = path.join(root, "governed", "nested");
    await mkdir(path.join(root, "governed", ".peach"), { recursive: true });
    await mkdir(governed, { recursive: true });
    await writeFile(path.join(root, "governed", ".peach", "execution.json"), JSON.stringify({ version: 1, integrationBranch: "develop" }));
    const push = (cwd: string, command: string) => landingGuardDecision({ tool_name: "Bash", cwd, tool_input: { command } });
    const denied = await push(governed, "jj git push -b develop");
    assert.equal(denied?.hookSpecificOutput.permissionDecision, "deny");
    assert.match(denied!.hookSpecificOutput.permissionDecisionReason, /peach-workspace land/);
    assert.equal(await push(governed, "jj git push -b master"), null, "only the declared integration branch is guarded");
    assert.equal(await push(root, "git push"), null, "an ungoverned repository is untouched");
    assert.equal(await landingGuardDecision({ tool_name: "Read", cwd: governed, tool_input: { file_path: "x" } }), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
