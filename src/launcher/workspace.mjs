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
  runPostLandVerification,
} from "../lib/peach-workspace.mjs";
import { execFileSync } from "node:child_process";

/** Disk use of a checkout, for spotting retained workspaces worth reclaiming. */
function diskUsage(root) {
  try { return execFileSync("du", ["-sh", root], { encoding: "utf8", timeout: 60_000 }).split("\t")[0]; }
  catch { return "?"; }
}

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "status") {
    const context = await workspaceContext();
    const postLand = context ? await latestPostLandResult(context.integration.root) : null;
    console.log(context
      ? JSON.stringify({ mode: await readWorkspaceMode(), workspace: context.current, integration: context.integration, integrationBranch: context.integrationBranch,
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
    const task = rest.join(" ").trim();
    if (!task) throw new Error('Usage: peach-workspace start "task"');
    const result = await createWorkspace(task);
    console.log(result.workspacePath);
  } else if (command === "preview") {
    const preview = await landingPreview();
    console.log(preview.stat || "(no changed files)");
  } else if (command === "land") {
    if (rest.some((flag) => flag !== "--local-only" && flag !== "--direct")) throw new Error("Usage: peach-workspace land [--local-only] [--direct]");
    // --direct lands the primary checkout itself, for a session explicitly working Direct.
    const result = await landWorkspace(process.cwd(), {
      localOnly: rest.includes("--local-only") ? true : undefined,
      allowDefaultWorkspace: rest.includes("--direct"),
      // This CLI, bundled or not, is its own background verification runner.
      postLandRunner: [process.execPath, process.argv[1], "post-land-run"],
    });
    console.log(JSON.stringify({ artifact: result.artifact, publication: result.publication, postIntegration: result.postIntegration,
      ...(result.postLand ? { postLand: result.postLand } : {}), ...(result.postLandWarning ? { postLandWarning: result.postLandWarning } : {}) }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "post-land-run") {
    // Internal: the detached process a landing starts for its background verification.
    await runPostLandVerification(rest[0]);
  } else if (command === "cleanup") {
    const result = await cleanupLandedWorkspace();
    console.log(result.cleaned ? "Workspace removed." : `Workspace retained: ${describeRetention(result)}.`);
  } else {
    console.error("Usage: peach-workspace <status|mode|list|pool [refill]|prune --empty|attach-issue|start|preview|land|cleanup>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
