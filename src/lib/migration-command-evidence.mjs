import { redactVerificationOutput } from "./verification-failure.mjs";
import { truncateUtf8 } from "./utf8.mjs";

/** Redact complete captured streams before clipping. A truncated capture can
 * start halfway through a credential, so withhold that stream rather than guess. */
export function redactMigrationOutput(value, root, environment = process.env) {
  let safe = String(value ?? "");
  for (const [key, secret] of Object.entries(environment)) {
    if (secret && /TOKEN|SECRET|PASSWORD|PASSWD|KEY|DATABASE|CREDENTIAL/i.test(key))
      safe = safe.split(secret).join("[REDACTED]");
  }
  safe = safe.replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi, "[REDACTED_URL]");
  return redactVerificationOutput(safe, root);
}

export function migrationCommandFailure(command, result, root, environment = process.env, subject = "Migration") {
  const redact = value => redactMigrationOutput(value, root, environment);
  const reason = result.cancelled ? "cancelled" : result.timedOut ? "timeout"
    : result.error ? "spawn_failure" : result.signal ? "signal" : "nonzero_exit";
  const evidence = {
    command: truncateUtf8(redact(command), 1000), outcome: reason,
    exitCode: result.exitCode ?? result.code ?? null, signal: result.signal ?? null,
    timedOut: result.timedOut === true, cancelled: result.cancelled === true,
    stdoutTruncated: result.stdoutTruncated === true || result.truncated === true,
    stderrTruncated: result.stderrTruncated === true || result.truncated === true,
    stdout: "", stderr: "",
    ...(result.error ? { error: truncateUtf8(redact(result.error), 1000) } : {}),
  };
  for (const stream of ["stdout", "stderr"]) {
    evidence[stream] = evidence[stream + "Truncated"] ? "[truncated output withheld]" : truncateUtf8(redact(result[stream]), 4096);
    if (Buffer.byteLength(redact(result[stream]), "utf8") > 4096) evidence[stream + "Truncated"] = true;
  }
  const error = new Error(`${subject} command failed (${reason}): ${evidence.command}\n${JSON.stringify(evidence)}`);
  error.evidence = evidence;
  return error;
}
