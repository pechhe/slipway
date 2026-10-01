/** The one real-path containment check for a declared command's repository-relative `cwd`. */
import { realpath } from "node:fs/promises";
import path from "node:path";

/**
 * Resolve `relative` (default: the root) inside `root` by real path, so a symlink in
 * the checkout cannot move a command outside it. Returns the real directory to run
 * in; throws before anything runs when it escapes or does not exist.
 */
export async function checkoutCwd(root, relative, subject) {
  const realRoot = await realpath(root);
  const declared = relative ?? ".";
  let real;
  try { real = await realpath(path.resolve(realRoot, declared)); }
  catch (error) { throw new Error(`${subject} cwd "${declared}" cannot be resolved inside the checkout (${error?.code ?? error?.message ?? error})`); }
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw new Error(`${subject} cwd "${declared}" resolves outside the checkout`);
  return real;
}
