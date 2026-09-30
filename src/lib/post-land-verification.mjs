/**
 * Background verification of a landed commit. A repository may declare
 * `postLandVerification` commands that are too slow to block every landing. Land
 * starts them after integration in a detached process, against an exact-revision
 * source view, without holding the landing slot. The outcome is a record that the
 * next landing and `peach-workspace status` report; it never changes the landed
 * integration.
 */
import { spawn } from "node:child_process";
import { appendFile, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, setPriority } from "node:os";
import path from "node:path";
import { runBoundedProcess } from "./bounded-process.mjs";
import { withFinalizationSource } from "./post-integration-source.mjs";
import { withVerificationSlot } from "./verification-slot.mjs";

const RETAINED_RECORDS = 30;
const CHECK_TIMEOUT_MS = 45 * 60_000;
const FAILURE_TAIL_LINES = 60;

export const postLandRoot = () => path.join(homedir(), ".pi", "agent", "workspace-state", "post-land");
const recordFile = (commit) => path.join(postLandRoot(), `${commit}.json`);

/** Declared post-land commands: `[{ executable, args, cwd? }]`. */
export function postLandChecks(value = []) {
  if (!Array.isArray(value)) throw new Error("Malformed postLandVerification policy");
  return value.map((check) => {
    if (!check || typeof check.executable !== "string" || !Array.isArray(check.args)
      || (check.cwd !== undefined && typeof check.cwd !== "string")) throw new Error("Malformed postLandVerification entry");
    return { executable: check.executable, args: check.args.map(String), ...(check.cwd ? { cwd: check.cwd } : {}) };
  });
}

/**
 * Queue a detached run for `base..commit`; returns its record. `runner` is the
 * command that runs one record file (appended); a bundled CLI supplies itself.
 */
export async function startPostLandVerification({ integrationRoot, gitDirectory, base, commit, checks, runner }) {
  await mkdir(postLandRoot(), { recursive: true, mode: 0o700 });
  const record = {
    version: 1, status: "queued", integrationRoot, gitDirectory, base, commit, checks,
    queuedAt: new Date().toISOString(), log: path.join(postLandRoot(), `${commit}.log`),
  };
  await writeFile(recordFile(commit), JSON.stringify(record, null, 2), { mode: 0o600 });
  const log = await open(record.log, "w", 0o600);
  try {
    // The landing process may exit at once; the run outlives it. By default the
    // child loads whichever module is running this code (source or the installed
    // helper bundle), which must export the runner.
    const [executable, ...args] = runner ?? ["node", "--input-type=module", "-e", RUNNER, import.meta.url];
    const child = spawn(executable, [...args, recordFile(commit)], {
      detached: true, stdio: ["ignore", log.fd, log.fd], env: process.env,
    });
    child.unref();
    // Kept apart from the record, which only the runner writes once started.
    if (child.pid) await writeFile(pidFile(commit), String(child.pid), { mode: 0o600 });
  } finally {
    await log.close();
  }
  await pruneRecords();
  return record;
}

const RUNNER = `
const [moduleUrl, file] = process.argv.slice(1);
const loaded = await import(moduleUrl);
if (typeof loaded.runPostLandVerification !== "function") throw new Error("This Peach build cannot run post-land verification: " + moduleUrl);
await loaded.runPostLandVerification(file);
`;

const pidFile = (commit) => path.join(postLandRoot(), `${commit}.pid`);

const alive = (pid) => {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
};

/** Records, with a run whose process is gone before it recorded a result reported as an error. */
async function readRecords() {
  const names = await readdir(postLandRoot()).catch(() => []);
  const records = await Promise.all(names.filter((name) => name.endsWith(".json"))
    .map((name) => readFile(path.join(postLandRoot(), name), "utf8").then(JSON.parse).catch(() => null)));
  return Promise.all(records.filter(Boolean).map(async (record) => {
    if (record.finishedAt) return record;
    const pid = Number(await readFile(pidFile(record.commit), "utf8").catch(() => ""));
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) return record;
    return { ...record, status: "error", reason: "the post-land process exited before recording a result", finishedAt: record.startedAt ?? record.queuedAt };
  }));
}

async function pruneRecords() {
  const settled = (await readRecords()).filter((record) => record.finishedAt)
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));
  for (const record of settled.slice(RETAINED_RECORDS)) {
    await rm(recordFile(record.commit), { force: true });
    await rm(pidFile(record.commit), { force: true });
    await rm(record.log, { force: true });
  }
}

/** The most recently finished run for a repository, if any. */
export async function latestPostLandResult(integrationRoot) {
  const finished = (await readRecords())
    .filter((record) => record.integrationRoot === integrationRoot && record.finishedAt)
    .sort((left, right) => right.finishedAt.localeCompare(left.finishedAt));
  return finished[0] ?? null;
}

/** One line for a run that did not pass, so the next landing sees it. */
export function describePostLandFailure(record) {
  if (!record || record.status === "passed") return null;
  const what = record.failed ? `${record.failed.command} exited ${record.failed.exitCode}` : record.reason ?? record.status;
  return `Post-land verification of ${record.commit.slice(0, 12)} ${record.status}: ${what}. Log: ${record.log}`;
}

async function runChecks(record, update) {
  // Imported here: the landing module imports this one to start runs.
  const { prepareWorkspaceDependencies } = await import("./peach-workspace.mjs");
  await withFinalizationSource(record.gitDirectory, record.commit, async (root) => {
    const env = { ...process.env, PEACH_POST_LAND_BASE: record.base, PEACH_POST_LAND_COMMIT: record.commit };
    console.log("[post-land] installing dependencies");
    await prepareWorkspaceDependencies(root, { quiet: true });
    for (const check of record.checks) {
      const command = `${check.executable} ${check.args.join(" ")}`.trim();
      console.log(`[post-land] ${command}`);
      const result = await runBoundedProcess({
        executable: check.executable, args: check.args, cwd: path.join(root, check.cwd ?? "."), env,
        timeoutMs: CHECK_TIMEOUT_MS, maxOutputBytes: 4 * 1024 * 1024,
      });
      await appendFile(record.log, `${result.stdout}${result.stderr}\n`);
      if (result.exitCode !== 0) {
        const tail = `${result.stdout}${result.stderr}`.trimEnd().split(/\r?\n/).slice(-FAILURE_TAIL_LINES).join("\n");
        await update({ status: "failed", failed: { command, exitCode: result.exitCode ?? result.signal ?? "timeout", tail } });
        return;
      }
    }
    await update({ status: "passed" });
  });
}

/** The detached run: wait for earlier runs, verify, record the outcome. */
export async function runPostLandVerification(file) {
  const record = JSON.parse(await readFile(file, "utf8"));
  const update = async (fields) => {
    Object.assign(record, fields);
    await writeFile(file, JSON.stringify(record, null, 2), { mode: 0o600 });
  };
  // Landings take priority over background verification for the machine.
  try { setPriority(10); } catch { /* unsupported */ }
  try {
    // Runs queue one at a time on their own slot, never the landing slot.
    await withVerificationSlot(async () => {
      await update({ status: "running", startedAt: new Date().toISOString() });
      await runChecks(record, update);
    }, { root: path.join(postLandRoot(), "queue"), env: {}, label: `post-land:${record.commit.slice(0, 12)}` });
  } catch (error) {
    await update({ status: "error", reason: error instanceof Error ? error.message : String(error) });
  }
  await update({ finishedAt: new Date().toISOString() });
}
