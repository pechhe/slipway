/** Shared native JJ writer-lock liveness semantics for Peach and vanilla Pi. */
export function workspaceWriterProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

export function workspaceWriterRecordMustBePreserved(lock) {
  return Boolean(
    lock
    && (workspaceWriterProcessAlive(lock.pid)
      || (typeof lock.ownerAgentRunId === "string" && lock.ownerAgentRunId.trim().length > 0)),
  );
}
