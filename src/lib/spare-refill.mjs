#!/usr/bin/env node
// The detached spare-pool refill (`startSpareRefill`): prepares one spare for the
// integration root given as the only argument and writes one line per outcome to
// its log. It is a closure entry beside workspace-lifecycle.mjs, and the build
// installs it beside the bundled lib/peach-workspace.mjs.
import { provisionSpare } from "./workspace-lifecycle.mjs";

const root = process.argv[2];
try {
  if (!root) throw new Error("spare-refill needs the integration root");
  console.log(new Date().toISOString(), JSON.stringify(await provisionSpare(root)));
} catch (error) {
  console.error(new Date().toISOString(), "refill failed:", error?.stack ?? error);
  process.exitCode = 1;
}
