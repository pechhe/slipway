#!/usr/bin/env node

import {
  attachWorkspaceIssue,
  cleanupLandedWorkspace,
  createWorkspace,
  landWorkspace,
  inspectWorkspaces,
  landingPreview,
  pruneEmptyWorkspaces,
  readWorkspaceMode,
  workspaceContext,
  writeWorkspaceMode,
  provisionSpare,
  readySpares,
  describeRetention,
  retainedWorkspaceMaterial,
  latestPostLandResult,
  readLandingState,
  runPostLandVerification,
  removeWorkspace,
  startSpareRefill,
} from "../lib/peach-workspace.mjs";
import { landingGuardDecision } from "../lib/landing-guard.mjs";
import { landingTimingLine } from "../lib/landing-timing.mjs";
import { execFileSync, spawn } from "node:child_process";
import { writeSync } from "node:fs";
import { setPriority } from "node:os";
import { resolve } from "node:path";

/** Disk use of a checkout, for spotting retained workspaces worth reclaiming. */
function diskUsage(root) {
  try { return execFileSync("du", ["-sh", root], { encoding: "utf8", timeout: 60_000 }).split("\t")[0]; }
  catch { return "?"; }
}

/** The repository's integration checkout, even when `cwd` is inside one of its workspaces. */
async function integrationRoot(cwd) {
  const context = await workspaceContext(cwd);
  if (!context) throw new Error(`Not inside a Jujutsu repository: ${cwd}`);
  return context.integration.root;
}

/**
 * `start` flags, which precede the task: `--integration` allocates from the
 * integration checkout even inside a workspace; `--issue <n>` creates or resumes
 * that Issue's workspace; `--refill` then starts a background spare refill;
 * `--json` prints one JSON result object. Null when the arguments are invalid.
 */
function startOptions(args) {
  const options = { integration: false, json: false, refill: false, issueNumber: undefined, resultFd: undefined, task: "" };
  let index = 0;
  for (; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === "--integration") options.integration = true;
    else if (flag === "--json") options.json = true;
    else if (flag === "--refill") options.refill = true;
    else if (flag === "--issue" || flag === "--result-fd") {
      const value = Number(args[index + 1]);
      if (!Number.isSafeInteger(value) || value <= 0) return null;
      if (flag === "--issue") options.issueNumber = value;
      else options.resultFd = value;
      index += 1;
    } else break;
  }
  options.task = args.slice(index).join(" ").trim();
  // A flag is a request for help or a typo, never a task to start a workspace for.
  if (options.task.startsWith("-") || (!options.task && !options.issueNumber)) return null;
  return options;
}

/**
 * `start --json`: run the start in a child whose stdout is this process's stderr,
 * so dependency-install output can never corrupt the JSON this process prints.
 */
async function startForJson(args) {
  const child = spawn(process.execPath, [...process.execArgv, process.argv[1], "start", "--result-fd", "3", ...args], {
    stdio: ["inherit", 2, "inherit", "pipe"],
  });
  let result = "";
  child.stdio[3].setEncoding("utf8").on("data", (chunk) => { result += chunk; });
  const code = await new Promise((resolveExit) => {
    child.once("error", (error) => { console.error(error.message); resolveExit(1); });
    child.once("close", (exit) => resolveExit(exit ?? 1));
  });
  if (code === 0 && result.trim()) process.stdout.write(result);
  return code === 0 && !result.trim() ? 1 : code;
}

/**
 * Remove the workspace at `path` if it has landed or is untouched; unfinished
 * work stays in place and reports failure, so a caller (such as Claude Code's
 * WorktreeRemove hook) never treats a kept workspace as removed.
 */
async function removeWorkspaceAt(path) {
  const context = await workspaceContext(path).catch(() => null);
  if (!context || context.current.name === "default") {
    console.log(`No isolated workspace at ${path}; nothing to remove.`);
    return 0;
  }
  const name = context.current.name;
  const result = await cleanupLandedWorkspace(path);
  if (result.cleaned) {
    console.log(`Removed landed workspace jj:${name}`);
    return 0;
  }
  if (result.reason === "not-landed") {
    try {
      await removeWorkspace(context.integration.root, name);
      console.log(`Removed untouched workspace jj:${name}`);
      return 0;
    } catch (error) {
      console.error(`Kept jj:${name}: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
  }
  console.error(`Kept jj:${name}: ${describeRetention(result)}`);
  return 1;
}

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "status") {
    const context = await workspaceContext();
    const postLand = context ? await latestPostLandResult(context.integration.root) : null;
    const landing = context && context.current.name !== "default" ? await readLandingState(context.current.name, { readOnly: true }) : null;
    console.log(context
      ? JSON.stringify({ mode: await readWorkspaceMode(), workspace: context.current, integration: context.integration, integrationBranch: context.integrationBranch,
        ...(landing ? { landing: { phase: landing.phase, artifactCommitId: landing.artifactCommitId, ...(landing.primaryCheckout ? { primaryCheckout: landing.primaryCheckout } : {}) } } : {}),
        ...(postLand ? { postLand: { commit: postLand.commit, status: postLand.status, finishedAt: postLand.finishedAt, log: postLand.log, ...(postLand.failed ? { failed: postLand.failed.command } : {}) } } : {}) }, null, 2)
      : "Not inside a Jujutsu repository");
  } else if (command === "mode") {
    const requested = rest[0];
    console.log(requested ? await writeWorkspaceMode(requested) : await readWorkspaceMode());
  } else if (command === "list") {
    const context = await workspaceContext();
    for (const workspace of await inspectWorkspaces()) {
      const issue = workspace.metadata?.issueNumber ? ` · issue #${workspace.metadata.issueNumber}` : "";
      const state = workspace.name === "default" ? "integration" : workspace.metadata?.spare ? "spare"
        : workspace.hasWork ? "unlanded" : workspace.landed ? "landed" : "empty";
      // Landed checkouts should be gone; say why one is still here and what it costs.
      const paths = state === "landed" && workspace.root && context
        ? await retainedWorkspaceMaterial(workspace.root, context.integration.root).catch(() => [])
        : [];
      const kept = paths.length ? ` · ${diskUsage(workspace.root)} kept: ${describeRetention({ reason: "unique-files", paths })}` : "";
      console.log(`${workspace.name}\t${workspace.root}\t${state}${issue}${kept}`);
    }
  } else if (command === "prune") {
    if (rest[0] !== "--empty") throw new Error("Usage: peach-workspace prune --empty");
    const result = await pruneEmptyWorkspaces();
    for (const name of result.removed) console.log(`Removed empty workspace: ${name}`);
    for (const skipped of result.skipped) console.error(`Skipped ${skipped.name}: ${skipped.reason}`);
    if (result.removed.length === 0 && result.skipped.length === 0) console.log("No empty workspaces to prune.");
  } else if (command === "pool") {
    if (rest[0] === "refill") console.log(JSON.stringify(await provisionSpare(), null, 2));
    else if (rest.length === 0) {
      const spares = await readySpares(process.cwd());
      console.log(spares.length ? spares.map((spare) => `ready\t${spare.name}\t${spare.root}`).join("\n") : "No ready spare workspace.");
    } else throw new Error("Usage: peach-workspace pool [refill]");
  } else if (command === "attach-issue") {
    const issueNumber = Number(rest[0]);
    const result = await attachWorkspaceIssue(process.cwd(), issueNumber);
    console.log(`Attached Issue #${result.issueNumber} to jj:${result.workspaceName}.`);
  } else if (command === "start") {
    const options = startOptions(rest);
    if (!options) {
      console.error('Usage: peach-workspace start [--integration] [--issue <n>] [--refill] [--json] ["task"]');
      process.exitCode = 2;
    } else if (options.json && options.resultFd === undefined) {
      process.exitCode = await startForJson(rest);
    } else {
      const root = options.integration ? await integrationRoot(process.cwd()) : process.cwd();
      const task = options.task || `Issue #${options.issueNumber}`;
      const result = await createWorkspace(task, root, options.issueNumber ? { issueNumber: options.issueNumber } : {});
      // Prepare the next session's spare in the background, so its start can claim it.
      const refill = options.refill ? await startSpareRefill(root).catch((error) => ({ started: false, reason: error.message })) : undefined;
      if (refill && !refill.started) console.error(`Spare refill not started: ${refill.reason}`);
      if (options.resultFd === undefined) console.log(result.workspacePath);
      else {
        writeSync(options.resultFd, `${JSON.stringify({
          workspacePath: result.workspacePath, workspaceName: result.current.name, integrationRoot: result.integration.root,
          issueNumber: options.issueNumber ?? null, created: result.created ?? false, reused: result.reused ?? false, pooled: Boolean(result.pooled),
          ...(refill ? { refill } : {}),
        })}\n`);
      }
    }
  } else if (command === "preview") {
    const preview = await landingPreview();
    console.log(preview.stat || "(no changed files)");
  } else if (command === "land") {
    if (rest.some((flag) => flag !== "--local-only" && flag !== "--direct")) throw new Error("Usage: peach-workspace land [--local-only] [--direct]");
    // --direct lands the primary checkout itself, for a session explicitly working Direct.
    const timing = { startedAt: Date.now(), stages: [] };
    const result = await landWorkspace(process.cwd(), {
      onStage: (stage) => timing.stages.push([stage, Date.now()]),
      localOnly: rest.includes("--local-only") ? true : undefined,
      allowDefaultWorkspace: rest.includes("--direct"),
      // This CLI, bundled or not, is its own background verification runner.
      postLandRunner: [process.execPath, process.argv[1], "post-land-run"],
    });
    // stderr, so stdout stays the JSON result.
    console.error(landingTimingLine({ ...timing, finishedAt: Date.now() }, result));
    console.log(JSON.stringify({ artifact: result.artifact, publication: result.publication, postIntegration: result.postIntegration,
      ...(result.primaryCheckout ? { primaryCheckout: result.primaryCheckout } : {}),
      ...(result.postLand ? { postLand: result.postLand } : {}), ...(result.postLandWarning ? { postLandWarning: result.postLandWarning } : {}) }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "post-land-run") {
    // Internal: the detached process a landing starts for its background
    // verification. Landings take priority over it for the machine.
    try { setPriority(10); } catch { /* unsupported */ }
    await runPostLandVerification(rest[0]);
  } else if (command === "guard") {
    // Claude Code PreToolUse hook: reads the tool call on stdin, prints a deny decision.
    let input = "";
    for await (const chunk of process.stdin) input += chunk;
    const decision = await landingGuardDecision(input.trim() ? JSON.parse(input) : {});
    if (decision) console.log(JSON.stringify(decision));
  } else if (command === "cleanup") {
    if (rest.length > 1 || rest[0]?.startsWith("-")) throw new Error("Usage: peach-workspace cleanup [path]");
    const result = await cleanupLandedWorkspace(rest[0] ? resolve(rest[0]) : process.cwd());
    console.log(result.cleaned ? "Workspace removed." : `Workspace retained: ${describeRetention(result)}.`);
    const superseded = result.supersededPostIntegration;
    if (superseded) console.log(`Superseded post-integration record (${superseded.status}, attempt ${superseded.attempt}${superseded.reason ? `: ${superseded.reason}` : ""}): a later landing published this artifact.`);
  } else if (command === "remove") {
    if (rest.length !== 1 || rest[0].startsWith("-")) throw new Error("Usage: peach-workspace remove <path>");
    process.exitCode = await removeWorkspaceAt(resolve(rest[0]));
  } else {
    console.error("Usage: peach-workspace <status|mode|list|pool [refill]|prune --empty|attach-issue|start|preview|land|cleanup [path]|remove <path>>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
