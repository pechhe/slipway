import { createHash } from "node:crypto";

const command = (value, field) => {
  if (!value || typeof value !== "object" || typeof value.executable !== "string"
    || !value.executable.trim() || !Array.isArray(value.args)
    || value.args.some((arg) => typeof arg !== "string")
    || (value.cwd != null && typeof value.cwd !== "string")) {
    throw new Error(`Malformed ${field} command`);
  }
  return { executable: value.executable, args: [...value.args], ...(typeof value.cwd === "string" ? { cwd: value.cwd } : {}),
    ...(value.baseline && typeof value.baseline === "object" ? { baseline: value.baseline } : {}) };
};

export function normalizeVerificationDeclaration(value, field = "requiredLocalVerification") {
  const base = command(value, field);
  if (value.capability == null) return base;
  const capability = value.capability;
  if (!capability || typeof capability !== "object" || typeof capability.id !== "string"
    || !capability.id.trim() || capability.onUnavailable !== "continue"
    || !Array.isArray(capability.unavailableExitCodes) || capability.unavailableExitCodes.length === 0
    || capability.unavailableExitCodes.some((code) => !Number.isInteger(code))
    || !Array.isArray(capability.unavailableStderrIncludes) || capability.unavailableStderrIncludes.length === 0
    || capability.unavailableStderrIncludes.some((part) => typeof part !== "string" || !part)) {
    throw new Error(`Malformed ${field}.capability declaration`);
  }
  return { ...base, capability: {
    id: capability.id, probe: command(capability.probe, `${field}.capability.probe`),
    onUnavailable: "continue", unavailableExitCodes: [...capability.unavailableExitCodes],
    unavailableStderrIncludes: [...capability.unavailableStderrIncludes],
  } };
}

export function classifyCapabilityProbe(capability, result) {
  if (!result || result.timedOut || result.cancelled || result.error || result.signal) return { status: "failed", reason: "probe did not complete normally" };
  if (result.code === 0 || result.exitCode === 0) return { status: "available" };
  const exitCode = result.code ?? result.exitCode;
  const stderr = String(result.stderr ?? "");
  const declared = capability.unavailableExitCodes.includes(exitCode)
    && capability.unavailableStderrIncludes.every((part) => stderr.includes(part));
  return declared
    ? { status: "unavailable", reason: stderr.trim().slice(0, 2_000) }
    : { status: "failed", reason: stderr.trim().slice(0, 2_000) || `probe exited ${exitCode}` };
}

const boundedCommand = (value) => Buffer.from(String(value), "utf8").subarray(0, 1_000).toString("utf8").replace(/\uFFFD+$/u, "");

export function verificationGap(capability, command, result, reason) {
  return {
    capability: capability.id,
    command: boundedCommand(command),
    reason: String(reason).slice(0, 2_000),
    probeCommand: boundedCommand([capability.probe.executable, ...capability.probe.args].join(" ")),
    probeExitCode: result.code ?? result.exitCode ?? null,
  };
}

export function verificationEvidence(passed, gaps, declarations) {
  return {
    status: gaps.length ? "passed_with_gaps" : "passed",
    passed: [...passed], gaps: [...gaps],
    policyDigest: createHash("sha256").update(JSON.stringify(declarations)).digest("hex"),
  };
}

export function verificationReviewEvidence(evidence) {
  return [
    ...evidence.passed,
    ...evidence.gaps.map((gap) => `UNAVAILABLE ${gap.capability}: ${gap.command} (${gap.reason})`),
  ];
}

export function normalizeDeclaredVerification(value) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    try {
      return [normalizeVerificationDeclaration(entry, `requiredLocalVerification[${index}]`)];
    } catch {
      return [];
    }
  });
}

