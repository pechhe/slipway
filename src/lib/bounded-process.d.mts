export type BoundedProcessOutput = {
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
};

export type BoundedProcessRequest = {
  executable: string;
  args: readonly string[];
  cwd: string;
  timeoutMs: number;
  maxOutputBytes: number;
  maxOutputBytesPerStream?: number;
  maxStoredOutputBytes?: number;
  input?: string | Buffer;
  env?: NodeJS.ProcessEnv;
  redactOutput?: (value: string) => string;
  abortSignal?: AbortSignal;
  fullStdoutHashPrefix?: string | Buffer;
  /** macOS seatbelt profile applied by the host process broker/local runner. */
  sandboxProfile?: string;
};

export type BoundedProcessResult = BoundedProcessOutput & {
  finishedAt: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  outputSha256: string;
  fullStdoutSha256?: string;
  error?: string;
};

export function sanitizedProcessEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
export function redactAndBoundProcessOutput(output: BoundedProcessOutput, maxBytes: number, redact?: (value: string) => string): BoundedProcessOutput;
export function runBoundedProcess(request: BoundedProcessRequest): Promise<BoundedProcessResult>;
