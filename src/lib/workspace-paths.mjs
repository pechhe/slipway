import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every filesystem location the landing tool owns, defined once. Each is read
 * from `HOME` at call time, so a hermetic test home applies to all of them.
 */

/** Where isolated JJ workspaces are created: `~/.pi/workspaces`. */
export const workspaceHome = () => join(homedir(), ".pi", "workspaces");

/** The Pi agent directory that holds the state home and the mode file. */
export const agentHome = () => join(homedir(), ".pi", "agent");

/** Checkout mode (`isolated`/`direct`) chosen through `peach-workspace mode`. */
export const modePath = () => join(agentHome(), "workspace-mode.json");

/** Machine-local landing state: top-level landing sidecars and verification slots. */
export const stateHome = () => join(agentHome(), "workspace-state");

/** Legacy per-workspace owner records and primary-checkout writer records. */
export const lockHome = () => join(stateHome(), "locks");

/** Per-workspace metadata (Issue, task, spare readiness). */
export const metadataHome = () => join(stateHome(), "workspaces");

/** Legacy landing sidecars and integrated-artifact evidence. */
export const landedHome = () => join(stateHome(), "landed");

/** Cross-process transaction locks. */
export const transactionHome = () => join(stateHome(), "transactions");

/** Background post-land verification records, logs and queues. */
export const postLandHome = () => join(stateHome(), "post-land");

/** Post-integration finalization receipts and locks. */
export const postIntegrationHome = () => join(stateHome(), "post-integration");

/** The detached spare refill's append-only log. */
export const poolRefillLogPath = () => join(stateHome(), "pool-refill.log");
