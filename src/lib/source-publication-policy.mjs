import { createHash } from "node:crypto";

export function sourcePublicationPolicy(value) {
  if (value === undefined) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["version", "mode", "remote"].includes(key))
    || value.version !== 1 || value.mode !== "required"
    || typeof value.remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.remote)) {
    throw new Error("Invalid source publication policy: expected version 1, required mode and one named remote");
  }
  return { version: 1, mode: "required", remote: value.remote };
}

export function sourcePublicationPolicyDigest(policy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}
