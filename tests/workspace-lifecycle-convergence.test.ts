import { project } from "./support/workspace-project.ts";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "vite-plus/test";
import { cleanupLandedWorkspace, createWorkspace, landWorkspace, renameWorkspace, statePath, workspaceMetadata } from "../src/lib/peach-workspace.mjs";

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
