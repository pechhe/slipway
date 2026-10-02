import type { WorkspaceContext } from "./workspace-jj.mjs";
import type { LandingAdapter, LandingRevision, LandingTail, LandingTailOptions } from "./landing-steps.mjs";
import type { createWorkspace } from "./workspace-create.mjs";
export function landWorkspace(cwd?: string, options?: LandingTailOptions & {
  allowDefaultWorkspace?: boolean;
  operationId?: string;
  onStage?: (stage: "preparing" | "rebasing" | "verifying" | "integrating" | "cleaning") => void;
  adapter?: LandingAdapter;
  /** `false` for a host that releases its own checkout records; others' disposable workspaces are otherwise swept after landing. */
  sweepOtherWorkspaces?: boolean;
  /** Receives one concise line per verification step; defaults to stdout. */
  onProgress?: (line: string) => void;
  /** Environment for the background post-land verification; defaults to `environment`. */
  postLandEnvironment?: () => NodeJS.ProcessEnv;
  /** Detached command that runs one post-land record file (appended), for a caller that exits after landing; long-lived hosts omit it and run in-process. */
  postLandRunner?: string[];
}): Promise<LandingTail & {
  artifact: LandingRevision; context: WorkspaceContext;
  cleanupPending?: boolean; cleanupError?: string;
  /** Whether the primary checkout was moved onto the new integration or left in place. */
  primaryCheckout?: import("./landing-candidate.mjs").PrimaryCheckoutOutcome;
  verification: import("./verification-policy.mjs").VerificationEvidence;
  /** The integration branch tip this landing verified against and advanced; absent when a rerun only republished. */
  base?: string;
  /** The declared background verification this landing started. */
  postLand?: { status: string; commit?: string; log?: string; reason?: string };
  /** An earlier landing's background verification on this repository did not pass. */
  postLandWarning?: string;
}>;
export function assertWorkspaceDelivered(cwd: string): Promise<Record<string, unknown>>;
export function prepareWorkspaceContinuation(task: string, cwd: string): ReturnType<typeof createWorkspace>;
