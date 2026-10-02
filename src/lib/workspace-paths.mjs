import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Every filesystem location the landing tool owns, defined once. Each is read
 * from `HOME` at call time, so a hermetic test home applies to all of them.
 *
 * slipway keeps its state, mode file and new workspaces under `~/.slipway`. A
 * machine that still holds pre-v1.0.0 state under `~/.pi` must run
 * `slipway cutover` first: until then every state, mode and workspace accessor
 * refuses, so this release never writes a second lock store beside the old one.
 */

/** slipway's home: `~/.slipway`. */
export const slipwayHome = () => join(homedir(), ".slipway");

/** Written as the last step of `slipway cutover`; its presence settles the cutover. */
export const cutoverMarkerPath = () => join(slipwayHome(), "cutover.json");

/** Pre-v1.0.0 locations, read only by the cutover (and kept usable for existing workspaces). */
export const legacyAgentHome = () => join(homedir(), ".pi", "agent");
export const legacyStateHome = () => join(legacyAgentHome(), "workspace-state");
export const legacyModePath = () => join(legacyAgentHome(), "workspace-mode.json");
export const legacyWorkspaceHome = () => join(homedir(), ".pi", "workspaces");

/** The retired `peach-workspace` CLI and library that `slipway cutover` replaces with refusing stubs. */
export const legacyEntryPoints = () => ({
  cli: join(legacyAgentHome(), "bin", "peach-workspace"),
  library: join(legacyAgentHome(), "lib", "peach-workspace.mjs"),
});

export const CUTOVER_REQUIRED_CODE = "SLIPWAY_CUTOVER_REQUIRED";

/** Pre-v1.0.0 state exists on this machine and `slipway cutover` has not run. */
export function cutoverPending() {
  return !existsSync(cutoverMarkerPath()) && (existsSync(legacyStateHome()) || existsSync(legacyModePath()));
}

/** Refuses while the cutover is pending, naming the command that settles it. */
export function assertCutoverSettled() {
  if (!cutoverPending()) return;
  const error = new Error(`slipway state still lives under ${legacyStateHome()} (pre-v1.0.0). `
    + "Run `slipway cutover` once while nothing is landing, then retry.");
  error.code = CUTOVER_REQUIRED_CODE;
  throw error;
}

const settled = (path) => { assertCutoverSettled(); return path; };

/** Where new isolated JJ workspaces are created: `~/.slipway/workspaces`. */
export const workspaceHome = () => settled(join(slipwayHome(), "workspaces"));

/**
 * Every directory slipway created workspaces in: the current home, then the
 * pre-v1.0.0 one, whose existing workspaces stay usable at their recorded paths.
 */
export const workspaceStorageHomes = () => [workspaceHome(), legacyWorkspaceHome()];

/** Checkout mode (`isolated`/`direct`) chosen through `slipway mode`. */
export const modePath = () => settled(join(slipwayHome(), "mode.json"));

/** Machine-local landing state: top-level landing sidecars and verification slots. */
export const stateHome = () => settled(join(slipwayHome(), "state"));

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
