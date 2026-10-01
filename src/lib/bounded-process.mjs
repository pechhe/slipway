import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { platform } from "node:os";
import { Cause, Data, Deferred, Effect, Exit, Option } from "effect";
import { truncateUtf8 } from "./utf8.mjs";
const ENV_ALLOWLIST = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "CI",
  "SystemRoot",
  "WINDIR"
];
export function sanitizedProcessEnv(source = process.env) {
  const env = {};
  for (const key of ENV_ALLOWLIST) {
    if (source[key])
      env[key] = source[key];
  }
  return env;
}
function processOutputSha256(stdout, stderr) {
  return createHash("sha256").update(`${stdout}
${stderr}`).digest("hex");
}
export function redactAndBoundProcessOutput(output, maxBytes, redact = (value) => value) {
  const limit = Math.max(0, Math.floor(maxBytes));
  const redactedStdout = redact(output.stdout);
  const redactedStderr = redact(output.stderr);
  const stdoutBytes = Buffer.byteLength(redactedStdout, "utf8");
  const stderrBytes = Buffer.byteLength(redactedStderr, "utf8");
  let stdoutLimit = Math.min(stdoutBytes, limit);
  let stderrLimit = Math.min(stderrBytes, Math.max(0, limit - stdoutLimit));
  if (stdoutBytes + stderrBytes > limit && stdoutBytes > 0 && stderrBytes > 0) {
    const half = Math.floor(limit / 2);
    stdoutLimit = stdoutBytes <= half ? stdoutBytes : Math.max(half, limit - stderrBytes);
    stderrLimit = limit - stdoutLimit;
  }
  const stdout = truncateUtf8HeadTail(redactedStdout, stdoutLimit);
  const stderr = truncateUtf8HeadTail(redactedStderr, stderrLimit);
  return {
    stdout,
    stderr,
    stdoutTruncated: output.stdoutTruncated || Buffer.byteLength(stdout, "utf8") < stdoutBytes,
    stderrTruncated: output.stderrTruncated || Buffer.byteLength(stderr, "utf8") < stderrBytes
  };
}
export function runBoundedProcess(request) {
  const maxOutputBytes = Math.max(0, Math.floor(request.maxOutputBytes));
  const maxOutputBytesPerStream = Math.max(0, Math.floor(request.maxOutputBytesPerStream ?? maxOutputBytes));
  const maxStoredOutputBytes = Math.max(0, Math.floor(request.maxStoredOutputBytes ?? maxOutputBytes));
  const env = request.env ?? sanitizedProcessEnv();
  const broker = globalThis.__peachRunBoundedProcess;
  if (broker) {
    const brokerEnv = Object.fromEntries(Object.entries(env).filter((entry) => entry[1] !== undefined));
    return broker({
      executable: request.executable,
      args: [...request.args],
      cwd: request.cwd,
      timeoutMs: request.timeoutMs,
      maxOutputBytes,
      maxOutputBytesPerStream,
      env: brokerEnv,
      ...request.input === undefined ? {} : { inputBase64: Buffer.from(request.input).toString("base64") },
      ...request.fullStdoutHashPrefix === undefined ? {} : { fullStdoutHashPrefixBase64: Buffer.from(request.fullStdoutHashPrefix).toString("base64") },
      ...request.sandboxProfile === undefined ? {} : { sandboxProfile: request.sandboxProfile }
    }, request.abortSignal).then((result) => {
      const output = redactAndBoundProcessOutput(result, maxStoredOutputBytes, request.redactOutput);
      return {
        ...result,
        cancelled: result.cancelled === true,
        ...output,
        outputSha256: processOutputSha256(output.stdout, output.stderr),
        ...result.error ? { error: redactError(result.error, request.redactOutput) } : {}
      };
    }).catch((error) => {
      const output = { stdout: "", stderr: "", stdoutTruncated: false, stderrTruncated: false };
      return {
        ...output,
        finishedAt: new Date().toISOString(),
        exitCode: null,
        signal: null,
        timedOut: false,
        cancelled: request.abortSignal?.aborted === true,
        outputSha256: processOutputSha256("", ""),
        ...request.fullStdoutHashPrefix === undefined ? {} : { fullStdoutSha256: createHash("sha256").update(request.fullStdoutHashPrefix).digest("hex") },
        error: redactError(error, request.redactOutput)
      };
    });
  }
  const fullStdoutHash = request.fullStdoutHashPrefix === undefined ? null : createHash("sha256").update(request.fullStdoutHashPrefix);
  const stdout = boundedOutput(Math.min(maxOutputBytesPerStream, Math.floor(maxOutputBytes / 2)));
  const stderr = boundedOutput(Math.min(maxOutputBytesPerStream, maxOutputBytes - Math.floor(maxOutputBytes / 2)));
  let closed;
  const lifetime = Effect.scoped(Effect.gen(function* () {
    const completion = yield* Deferred.make();
    const child = yield* Effect.acquireRelease(Effect.try({
      try: () => {
        const executable = process.platform === "darwin" && request.sandboxProfile ? "sandbox-exec" : request.executable;
        const args = process.platform === "darwin" && request.sandboxProfile ? ["-p", request.sandboxProfile, request.executable, ...request.args] : [...request.args];
        const child = spawn(executable, args, {
          cwd: request.cwd,
          env,
          shell: false,
          windowsHide: true,
          stdio: [request.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
          detached: process.platform !== "win32"
        });
        child.once("error", (cause) => Deferred.doneUnsafe(completion, Effect.fail(new ProcessSpawnError({ cause }))));
        child.once("close", (exitCode, signal) => {
          closed = { exitCode, signal };
          Deferred.doneUnsafe(completion, Effect.void);
        });
        child.stdout?.on("data", (chunk) => {
          fullStdoutHash?.update(chunk);
          stdout.add(chunk);
        });
        child.stderr?.on("data", (chunk) => stderr.add(chunk));
        child.stdin?.on("error", () => {});
        return child;
      },
      catch: (cause) => new ProcessSpawnError({ cause })
    }), (child, exit) => Exit.isFailure(exit) ? Effect.gen(function* () {
      signalProcessGroup(child, "SIGTERM");
      yield* Effect.sleep(250);
      signalProcessGroup(child, "SIGKILL");
      yield* Deferred.await(completion).pipe(Effect.interruptible, Effect.ignore, Effect.timeoutOption(250));
    }) : Effect.void);
    if (request.input !== undefined)
      child.stdin?.end(request.input);
    yield* Deferred.await(completion).pipe(Effect.timeoutOrElse({
      duration: Math.max(1, Math.floor(request.timeoutMs)),
      orElse: () => Effect.fail(new ProcessDeadline)
    }));
  }));
  return Effect.runPromiseExit(lifetime, { signal: request.abortSignal }).then((exit) => {
    const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : Option.none();
    const cancelled = Exit.isFailure(exit) && Cause.hasInterruptsOnly(exit.cause);
    if (Exit.isFailure(exit) && Option.isNone(failure) && !Cause.hasInterruptsOnly(exit.cause)) {
      throw Cause.squash(exit.cause);
    }
    const error = Option.isSome(failure) && failure.value._tag === "ProcessSpawnError" ? redactError(failure.value.cause, request.redactOutput) : undefined;
    const output = finalizeOutput(stdout, stderr, maxStoredOutputBytes, request.redactOutput);
    return {
      ...output,
      finishedAt: new Date().toISOString(),
      exitCode: error ? null : closed?.exitCode ?? null,
      signal: closed?.signal ?? null,
      timedOut: Option.isSome(failure) && failure.value._tag === "ProcessDeadline",
      cancelled,
      outputSha256: processOutputSha256(output.stdout, output.stderr),
      ...fullStdoutHash ? { fullStdoutSha256: fullStdoutHash.digest("hex") } : {},
      ...error ? { error } : {}
    };
  });
}

class ProcessDeadline extends Data.TaggedError("ProcessDeadline") {
}

class ProcessSpawnError extends Data.TaggedError("ProcessSpawnError") {
}
function finalizeOutput(stdout, stderr, maxStoredOutputBytes, redact) {
  return redactAndBoundProcessOutput({
    stdout: stdout.value(),
    stderr: stderr.value(),
    stdoutTruncated: stdout.truncated,
    stderrTruncated: stderr.truncated
  }, maxStoredOutputBytes, redact);
}
function boundedOutput(streamLimit) {
  const headLimit = Math.floor(streamLimit / 2);
  const tailLimit = streamLimit - headLimit;
  const head = [];
  const tail = [];
  let headBytes = 0;
  let tailBytes = 0;
  let totalBytes = 0;
  let truncated = false;
  return {
    add(chunk) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      totalBytes += buffer.length;
      if (headBytes < headLimit) {
        const kept = buffer.subarray(0, Math.min(buffer.length, headLimit - headBytes));
        if (kept.length) {
          head.push(kept);
          headBytes += kept.length;
        }
      }
      if (tailLimit > 0 && buffer.length > 0) {
        tail.push(buffer);
        tailBytes += buffer.length;
        while (tailBytes > tailLimit && tail.length > 0) {
          const excess = tailBytes - tailLimit;
          const first = tail[0];
          if (first.length <= excess) {
            tail.shift();
            tailBytes -= first.length;
          } else {
            tail[0] = first.subarray(excess);
            tailBytes -= excess;
          }
        }
      }
      truncated = totalBytes > streamLimit;
    },
    value: () => {
      const headValue = Buffer.concat(head);
      const tailValue = Buffer.concat(tail);
      if (!truncated) {
        const overlap = Math.max(0, headBytes + tailBytes - totalBytes);
        return Buffer.concat([headValue, tailValue.subarray(overlap)]).toString("utf8");
      }
      return joinCapturedEdges(headValue, tailValue, streamLimit);
    },
    get truncated() {
      return truncated;
    }
  };
}
function redactError(error, redact) {
  const raw = error instanceof Error ? error.message : String(error);
  return (redact ? redact(raw) : raw).slice(0, 1000);
}
const OUTPUT_OMISSION = `
…
`;
function joinCapturedEdges(head, tail, maxBytes) {
  if (maxBytes <= 0)
    return "";
  const marker = Buffer.from(OUTPUT_OMISSION);
  if (marker.length >= maxBytes)
    return utf8Prefix(head, maxBytes);
  const available = maxBytes - marker.length;
  return `${utf8Prefix(head, Math.floor(available / 2))}${OUTPUT_OMISSION}${utf8Suffix(tail, available - Math.floor(available / 2))}`;
}
function truncateUtf8HeadTail(value, maxBytes) {
  const source = Buffer.from(value, "utf8");
  if (source.length <= maxBytes)
    return value;
  if (source.length - maxBytes <= Buffer.byteLength(OUTPUT_OMISSION))
    return utf8Prefix(source, maxBytes);
  return joinCapturedEdges(source, source, maxBytes);
}
function utf8Prefix(value, maxBytes) {
  return value.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD+$/u, "");
}
function utf8Suffix(value, maxBytes) {
  return value.subarray(Math.max(0, value.length - maxBytes)).toString("utf8").replace(/^\uFFFD+/u, "");
}
function signalProcessGroup(child, signal) {
  if (child.pid === undefined)
    return;
  try {
    if (platform() === "win32")
      child.kill(signal);
    else
      process.kill(-child.pid, signal);
  } catch {}
}
