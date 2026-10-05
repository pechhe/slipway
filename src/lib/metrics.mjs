import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stateHome } from "./workspace-paths.mjs";

/**
 * Append one JSON line to `<state>/metrics/<kind>.jsonl`, so a slow day can be
 * explained afterwards. Best effort: a metrics failure never fails the command.
 */
export async function appendMetric(kind, record, { root = join(stateHome(), "metrics") } = {}) {
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await appendFile(join(root, `${kind}.jsonl`), `${JSON.stringify({ at: new Date().toISOString(), ...record })}\n`, { mode: 0o600 });
  } catch {}
}
