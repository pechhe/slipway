#!/usr/bin/env node
// The detached spare-pool refill (`startSpareRefill`): tops the pool of the
// integration root given as the only argument up to its declared `spares`, one
// prepared spare at a time, and writes one line per outcome to its log. Other
// refills may run beside it (one per claim); the pool counts spares in progress,
// so together they never exceed the declaration. It is a closure entry beside
// workspace-pool.mjs.
import { provisionSpare } from "./workspace-pool.mjs";

const root = process.argv[2];
try {
  if (!root) throw new Error("spare-refill needs the integration root");
  for (;;) {
    const outcome = await provisionSpare(root);
    console.log(new Date().toISOString(), JSON.stringify(outcome));
    if (!outcome.provisioned) break;
  }
} catch (error) {
  console.error(new Date().toISOString(), "refill failed:", error?.stack ?? error);
  process.exitCode = 1;
}
