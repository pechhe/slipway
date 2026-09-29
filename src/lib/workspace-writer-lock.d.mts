export declare const WORKSPACE_TAKEOVER_TOOL: "peach_workspace_takeover";
export declare function workspaceWriterProcessAlive(pid: unknown): boolean;
export declare function workspaceWriterRecordMustBePreserved(lock: Record<string, unknown> | null | undefined): boolean;
export declare function workspaceWriterLockFile(workspaceName: string): string;

export interface WorkspaceWriterIdentity {
  pid: number | null;
  surface: string;
  ownerAgentRunId: string | null;
  acquiredAt: string | null;
  takeoverId: string | null;
}
/** Any writer-lock record; fields are validated at runtime. */
export type WorkspaceWriterRecord = object;
export declare function workspaceWriterIdentity(lock: WorkspaceWriterRecord | null | undefined): WorkspaceWriterIdentity | null;
export declare function describeWorkspaceWriter(lock: WorkspaceWriterRecord | null | undefined): string;
export declare function workspaceTakeoverInstruction(target?: { workspaceName?: string; issueNumber?: number | null }): string;
export declare function workspaceCurrentWriterRefusal(input: {
  workspaceName: string;
  issueNumber?: number | null;
  lock: WorkspaceWriterRecord | null | undefined;
}): string;
export declare function workspaceOwnerSuperseded(workspaceName: string, ownerAgentRunId: unknown): Promise<boolean>;
export declare function assertWorkspaceOwnerNotSuperseded(workspaceName: string, ownerAgentRunId: unknown): Promise<void>;
export declare function workspaceLandingWriterRefusal(
  lock: WorkspaceWriterRecord | null | undefined,
  ownPids?: readonly number[],
): string | null;

export interface WorkspaceTakeoverOwner {
  surface: string;
  pid: number;
  ownerAgentRunId?: string;
}
export interface WorkspaceTakeoverInput {
  workspaceName: string;
  workspacePath: string;
  authorisation: { humanAuthorised: true; reason: string };
  owner: WorkspaceTakeoverOwner;
  /** Writer observed when the human authorised the takeover; defaults to the current one. */
  expectedOwner?: WorkspaceWriterIdentity | null;
}
export interface WorkspaceTakeoverResult {
  workspaceName: string;
  changed: boolean;
  takeoverId?: string;
  at?: string;
  previousOwner: Record<string, unknown> | null;
  owner: Record<string, unknown>;
  previousOwnerLive?: boolean;
  terminated?: boolean;
}
export declare function takeOverWorkspaceWriter(input: WorkspaceTakeoverInput): Promise<WorkspaceTakeoverResult>;
