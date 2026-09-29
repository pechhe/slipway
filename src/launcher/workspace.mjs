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
} from "../lib/peach-workspace.mjs";
import { runReviewCommand } from "../github-reviews/index.ts";

const [command, ...rest] = process.argv.slice(2);

try {
  if (command === "review") {
    console.log(JSON.stringify(await runReviewCommand(rest, process.cwd()), null, 2));
  } else if (command === "status") {
    const context = await workspaceContext();
    console.log(context
      ? JSON.stringify({ mode: await readWorkspaceMode(), workspace: context.current, integration: context.integration, integrationBranch: context.integrationBranch }, null, 2)
      : "Not inside a Jujutsu repository");
  } else if (command === "mode") {
    const requested = rest[0];
    console.log(requested ? await writeWorkspaceMode(requested) : await readWorkspaceMode());
  } else if (command === "list") {
    for (const workspace of await inspectWorkspaces()) {
      const issue = workspace.metadata?.issueNumber ? ` · issue #${workspace.metadata.issueNumber}` : "";
      const owner = workspace.lock ? ` · active pid ${workspace.lock.pid}` : "";
      const state = workspace.name === "default" ? "integration" : workspace.metadata?.spare ? "spare"
        : workspace.hasWork ? "unlanded" : workspace.landed ? "landed" : "empty";
      console.log(`${workspace.name}\t${workspace.root}\t${state}${issue}${owner}`);
    }
  } else if (command === "prune") {
    if (rest[0] !== "--empty") throw new Error("Usage: peach-workspace prune --empty");
    const result = await pruneEmptyWorkspaces();
    for (const name of result.removed) console.log(`Removed empty workspace: ${name}`);
    for (const skipped of result.skipped) console.error(`Skipped ${skipped.name}: ${skipped.reason}`);
    if (result.removed.length === 0 && result.skipped.length === 0) console.log("No empty unowned workspaces to prune.");
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
    if (rest.some((flag) => flag !== "--local-only")) throw new Error("Usage: peach-workspace land [--local-only]");
    const result = await landWorkspace(process.cwd(), { localOnly: rest.includes("--local-only") ? true : undefined });
    console.log(JSON.stringify({ artifact: result.artifact, publication: result.publication }, null, 2));
    if (!result.ok) process.exitCode = 1;
  } else if (command === "cleanup") {
    const result = await cleanupLandedWorkspace();
    console.log(result.cleaned ? "Workspace removed." : `Workspace retained: ${result.reason}.`);
  } else {
    console.error("Usage: peach-workspace <status|mode|list|pool [refill]|prune --empty|attach-issue|start|preview|land|cleanup|review>");
    process.exitCode = 2;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
