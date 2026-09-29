export type PrimaryWriterRecord = {
  version: 1; kind: "primary-checkout"; pid: number; surface: "peach" | "local"; owner: string;
  workspaceName: "default"; workspacePath: string; acquiredAt: string;
};
export declare function primaryWriterName(integrationRoot: string): Promise<string>;
export declare function activePrimaryWriter(integrationRoot: string): Promise<PrimaryWriterRecord | null>;
export declare function assertNoForeignPrimaryWriter(integrationRoot: string, owner?: string): Promise<void>;
export declare function acquirePrimaryWriter(input: {
  integrationRoot: string; integrationBranch: string; owner: string; surface: "peach" | "local";
}): Promise<() => Promise<void>>;
export declare function releasePrimaryWriter(integrationRoot: string, owner: string): Promise<void>;
