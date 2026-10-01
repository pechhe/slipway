import { jj, project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace, createWorkspace, landWorkspace, renameWorkspace, statePath, workspaceMetadata } from "../src/lib/peach-workspace.mjs";
import { withinWorkspaceStorage } from "../src/lib/workspace-lifecycle.mjs";

const landedPath = (name: string) => join(homedir(), ".pi", "agent", "workspace-state", "landed", `${name}.json`);
const readJson = async (path: string) => JSON.parse(await readFile(path, "utf8"));

const cli = fileURLToPath(new URL("../src/launcher/workspace.mjs", import.meta.url));

function runCli(cwd: string, args: string[]) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolveRun) => {
    execFile(process.execPath, [cli, ...args], { cwd }, (error, stdout, stderr) =>
      resolveRun({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr }));
  });
}

async function landed(f: Awaited<ReturnType<typeof project>>, file: string) {
  const workspace = await createWorkspace(file, f.repo);
  await writeFile(join(workspace.workspacePath, file), `${file}\n`);
  const result = await landWorkspace(workspace.workspacePath, { onProgress: () => {} });
  assert.equal(result.ok, true, JSON.stringify(result.publication));
  return workspace;
}

test("attaching an Issue to a landed workspace is refused", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "attach.txt");
    const result = await runCli(workspace.workspacePath, ["attach-issue", "77"]);
    assert.equal(result.code, 1);
    assert.match(result.stderr, /has landed, so it is read-only/);
    assert.equal((await workspaceMetadata(workspace.current.name))?.issueNumber, undefined);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("rename preserves landing state in both locations with its history", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "rename.txt");
    const oldName = workspace.current.name;
    // A legacy landing record lives under landed/ beside the current top-level one.
    await mkdir(join(landedPath(oldName), ".."), { recursive: true });
    await copyFile(statePath(oldName), landedPath(oldName));

    const { name } = await renameWorkspace(workspace.workspacePath, "renamed task");
    assert.equal(name, "renamed-task");
    for (const path of [statePath(name), landedPath(name)]) {
      const state = await readJson(path);
      assert.equal(state.workspaceName, name);
      assert.deepEqual(state.previousWorkspaceNames, [oldName]);
    }
    assert.equal(existsSync(statePath(oldName)), false);
    assert.equal(existsSync(landedPath(oldName)), false);
    const metadata = await workspaceMetadata(name);
    assert.deepEqual(metadata?.previousWorkspaceNames, [oldName]);
    assert.equal((metadata?.workspaceRenameEpochs as Array<{ toName: string }> | undefined)?.at(-1)?.toName, name);
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
  } finally {
    await f.dispose();
  }
}, 120_000);

const verifiedLines = async (file: string) => (await readFile(file, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

async function waitFor(condition: () => boolean | Promise<boolean>) {
  while (!await condition()) await new Promise((resolveWait) => setTimeout(resolveWait, 25));
}

test("a prepared landing whose bookmark already moved is finished, not verified again", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "prepared.txt");
    // A crash after the bookmark moved leaves only the prepared record, here the legacy one.
    const state = await readJson(statePath(workspace.current.name));
    await mkdir(join(landedPath(workspace.current.name), ".."), { recursive: true });
    await writeFile(landedPath(workspace.current.name), JSON.stringify({ ...state, phase: "prepared", cleanupPending: true }));
    await rm(statePath(workspace.current.name));
    const before = await verifiedLines(f.verified);

    const rerun = await landWorkspace(workspace.workspacePath, { onProgress: () => {} });
    assert.equal(rerun.ok, true, JSON.stringify(rerun.publication));
    assert.equal(rerun.artifact.commitId, state.artifactCommitId);
    assert.equal(await verifiedLines(f.verified), before, "landed source is not verified again");
    assert.equal((await readJson(statePath(workspace.current.name))).cleanupPending, false);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("cleanup retries pending housekeeping before releasing a landed workspace", async () => {
  const f = await project();
  try {
    const workspace = await landed(f, "pending.txt");
    const state = await readJson(statePath(workspace.current.name));
    await writeFile(statePath(workspace.current.name), JSON.stringify({ ...state, cleanupPending: true, cleanupError: "interrupted" }));
    assert.deepEqual(await cleanupLandedWorkspace(workspace.workspacePath), { cleaned: true });
    assert.equal(existsSync(workspace.workspacePath), false);
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a landing and a cleanup of the same workspace serialize on one key", async () => {
  const f = await project({ verify: (verified) => `touch "$PEACH_TEST_GATE.started"; while [ ! -f "$PEACH_TEST_GATE" ]; do sleep 0.05; done; pwd >> ${JSON.stringify(verified)}` });
  const gate = join(f.root, "gate");
  process.env.PEACH_TEST_GATE = gate;
  try {
    const workspace = await createWorkspace("serialized", f.repo);
    await writeFile(join(workspace.workspacePath, "serialized.txt"), "serialized\n");
    const landing = landWorkspace(workspace.workspacePath, { onProgress: () => {} });
    await waitFor(() => existsSync(`${gate}.started`));
    const cleanup = cleanupLandedWorkspace(workspace.workspacePath);
    await writeFile(gate, "");
    assert.equal((await landing).ok, true);
    // Run during verification, cleanup would have found no landing; it waited for the integration instead.
    assert.deepEqual(await cleanup, { cleaned: true });
  } finally {
    delete process.env.PEACH_TEST_GATE;
    await f.dispose();
  }
}, 120_000);

test("cleanup refuses a checkout outside workspace storage", async () => {
  const f = await project();
  try {
    const outside = join(f.root, "outside");
    jj(f.repo, ["workspace", "add", "--name", "outside", outside]);
    await writeFile(join(outside, "outside.txt"), "outside\n");
    assert.equal((await landWorkspace(outside, { onProgress: () => {} })).ok, true);
    assert.equal(await withinWorkspaceStorage(outside), false);
    assert.deepEqual(await cleanupLandedWorkspace(outside), { cleaned: false, reason: "outside-workspace-storage" });
    assert.ok(existsSync(join(outside, "outside.txt")));
  } finally {
    await f.dispose();
  }
}, 120_000);

test("a hung jj fetch times out instead of holding the landing", async () => {
  const f = await project();
  const hang = join(f.root, "hang-ssh");
  await writeFile(hang, "#!/bin/sh\nexec sleep 600\n", { mode: 0o755 });
  jj(f.repo, ["git", "remote", "set-url", "origin", "ssh://hang.invalid/remote.git"]);
  // GIT_SSH_COMMAND reaches git as a credential key of the landing command environment.
  process.env.GIT_SSH_COMMAND = hang;
  process.env.PEACH_WORKSPACE_COMMAND_TIMEOUT_MS = "1500";
  try {
    const workspace = await createWorkspace("hung remote", f.repo);
    await writeFile(join(workspace.workspacePath, "hung.txt"), "hung\n");
    const result = await landWorkspace(workspace.workspacePath, { onProgress: () => {} });
    assert.equal(result.ok, false);
    assert.equal(result.publication.status, "push_failed");
    assert.match(result.publication.reason ?? "", /timed out after/);
    assert.equal(jj(f.repo, ["log", "-r", "main", "--no-graph", "-T", "commit_id"]), result.artifact.commitId, "the local integration is kept");
  } finally {
    delete process.env.GIT_SSH_COMMAND;
    delete process.env.PEACH_WORKSPACE_COMMAND_TIMEOUT_MS;
    await f.dispose();
  }
}, 120_000);
