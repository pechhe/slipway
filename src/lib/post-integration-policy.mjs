import { createHash } from "node:crypto";
import path from "node:path";
function object(value) {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid post-integration policy");
  return value;
}
function command(value) {
  const row = object(value);
  if (typeof row.executable !== "string" || !row.executable.trim() || row.executable.includes("\x00") || !Array.isArray(row.args) || row.args.some((arg) => typeof arg !== "string" || arg.includes("\x00"))) {
    throw new Error("Invalid post-integration command");
  }
  const cwd = row.cwd ?? ".";
  if (typeof cwd !== "string" || path.isAbsolute(cwd) || cwd.includes("\x00") || cwd.split(/[\\/]/).includes(".."))
    throw new Error("Post-integration cwd must stay within the exact source view");
  return { executable: row.executable, args: [...row.args], cwd };
}
export function postIntegrationPolicy(value) {
  if (value === undefined)
    return null;
  const row = object(value);
  if (row.version !== 1 || row.idempotency !== "artifact-key" || typeof row.target !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(row.target) || !Number.isInteger(row.timeoutMs) || Number(row.timeoutMs) < 1 || Number(row.timeoutMs) > 600000) {
    throw new Error("Invalid post-integration identity, idempotency contract or deadline");
  }
  const keys = row.environmentKeys ?? [];
  if (!Array.isArray(keys) || keys.some((key) => typeof key !== "string" || !/^[A-Z_][A-Z0-9_]*$/.test(key) || key.startsWith("PEACH_FINALIZATION_") || ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "NODE_OPTIONS", "BUN_OPTIONS"].includes(key))) {
    throw new Error("Invalid post-integration environment declaration");
  }
  const approvalMode = row.approvalMode ?? "explicit-human";
  if (!["explicit-human", "automatic-development"].includes(approvalMode)) {
    throw new Error("Invalid post-integration approval mode");
  }
  return {
    version: 1,
    target: row.target,
    idempotency: "artifact-key",
    command: command(row.command),
    targetProbe: command(row.targetProbe),
    timeoutMs: Number(row.timeoutMs),
    environmentKeys: [...new Set(keys)],
    approvalMode
  };
}
export function postIntegrationPolicyDigest(policy) {
  return createHash("sha256").update(JSON.stringify(policy)).digest("hex");
}
export function exactPostIntegrationApproval(value, commit, digest, target) {
  if (!value || typeof value !== "object")
    return false;
  const row = value;
  return row.humanApproved === true && row.integratedCommitSha === commit && row.policyDigest === digest && row.target === target;
}
