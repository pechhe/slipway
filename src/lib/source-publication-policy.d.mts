export type SourcePublicationPolicy = {
  version: 1;
  mode: "required";
  remote: string;
};

export function sourcePublicationPolicy(value: unknown): SourcePublicationPolicy | null;
export function sourcePublicationPolicyDigest(policy: SourcePublicationPolicy): string;
