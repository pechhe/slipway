/**
 * A Claude Code PreToolUse guard: in a repository governed by `slipway.json`, the
 * integration branch moves and is published only through `slipway land`, and a
 * declared release branch only through `slipway release`.
 * Pushing feature bookmarks for a pull request stays allowed.
 */
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { EXECUTION_POLICY_PROBE_PATHS, parseExecutionPolicy, selectExecutionPolicyPath } from "./execution-policy.mjs";

const LAND = "Use `slipway land` (or `--direct` in a Direct checkout): it verifies, integrates and pushes.";
const RELEASE = "Use `slipway release`: it verifies the exact candidate and publishes the release after human approval.";

/** The raw `integrationBranch` of an unparseable or refused policy text, if it names one. */
const rawBranch = (raw) => {
  try { const declared = JSON.parse(raw)?.integrationBranch; return typeof declared === "string" && declared ? declared : null; } catch { return null; }
};

/**
 * Nearest policy above `cwd` and the branches it guards, or null when ungoverned.
 * A directory with only the retired `.peach/execution.json` is refused, not read,
 * but still guarded (fail closed): `retired` carries the refusal for the deny reason.
 */
async function governance(cwd) {
  for (let dir = cwd; ; dir = dirname(dir)) {
    const texts = new Map();
    for (const candidate of EXECUTION_POLICY_PROBE_PATHS) {
      const text = await readFile(join(dir, candidate), "utf8").catch(() => null);
      if (text !== null) texts.set(candidate, text);
    }
    let found;
    try { found = await selectExecutionPolicyPath(async (candidate) => texts.has(candidate), dir); } catch (error) {
      const declared = rawBranch([...texts.values()][0]);
      return { branches: [...new Set([...(declared ? [declared] : []), "main", "master"])], release: null, retired: error.message };
    }
    if (found !== null) {
      const raw = texts.get(found);
      let declared;
      let release = null;
      // An invalid policy still governs: keep guarding whatever branch it names.
      try {
        const policy = parseExecutionPolicy(raw, found);
        declared = policy.integrationBranch;
        release = policy.releaseBranch ?? null;
      } catch { declared = rawBranch(raw); }
      const integration = typeof declared === "string" && declared ? [declared] : ["main", "master"];
      return { branches: [...new Set([...integration, ...(release ? [release] : [])])], release, retired: null };
    }
    if (dirname(dir) === dir) return null;
  }
}

/** Nearest policy above `cwd` (`slipway.json`), with its guarded branches; null when ungoverned. */
export async function governedBranches(cwd) {
  return (await governance(cwd))?.branches ?? null;
}

/** Split a shell line into simple commands' words; quoting is honoured, expansion is not attempted. */
export function simpleCommands(line) {
  const commands = [];
  let words = [];
  let word = "";
  let quote = null;
  const endWord = () => { if (word) words.push(word); word = ""; };
  const endCommand = () => { endWord(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && i + 1 < line.length) word += line[++i];
      else word += char;
    } else if (char === "'" || char === '"') quote = char;
    else if (char === "\\" && i + 1 < line.length) word += line[++i];
    else if (char === "\n" || ";&|()`".includes(char) || (char === "$" && line[i + 1] === "(")) endCommand();
    else if (/\s/.test(char)) endWord();
    else word += char;
  }
  endCommand();
  // Leading environment assignments and wrappers do not change what runs.
  return commands.map((command) => {
    let start = 0;
    while (start < command.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(command[start]) || ["env", "command", "exec", "sudo", "nohup", "time"].includes(command[start]))) start += 1;
    return command.slice(start);
  }).filter((command) => command.length);
}

/** The subcommand and its arguments, past global options (and the values those options take). */
function subcommand(args, valued) {
  let i = 0;
  while (i < args.length && args[i].startsWith("-")) i += valued.includes(args[i]) ? 2 : 1;
  return args.slice(i);
}

const branchOf = (ref) => ref.replace(/^\+/, "").split(":").pop().replace(/^refs\/heads\//, "");

/** A violation is `[reason, branch]`; the branch is null when the command is not specific to one. */
function gitViolation(args, branches) {
  const [verb, ...rest] = subcommand(args, ["-C", "-c", "--git-dir", "--work-tree", "--namespace"]);
  if (verb === "push") {
    if (rest.some((arg) => ["--all", "--mirror", "--delete", "-d"].includes(arg))) return ["pushes every branch or deletes one", null];
    const refspecs = rest.filter((arg) => !arg.startsWith("-")).slice(1);
    if (!refspecs.length) return ["pushes the current branch, which may be the integration branch", null];
    const hit = refspecs.map(branchOf).find((branch) => branches.includes(branch));
    return hit ? [`pushes ${hit}`, hit] : null;
  }
  if (verb === "update-ref") {
    const hit = rest.map(branchOf).find((branch) => branches.includes(branch));
    return hit ? [`moves ${hit}`, hit] : null;
  }
  if (verb === "branch" && rest.some((arg) => /^-(?:f|D|m|M|-force|-delete|-move)/.test(arg))) {
    const hit = rest.find((arg) => branches.includes(arg));
    return hit ? [`rewrites ${hit}`, hit] : null;
  }
  return null;
}

const BOOKMARK_ACTIONS = { s: "set", set: "set", m: "move", move: "move", c: "create", create: "create",
  d: "delete", delete: "delete", f: "forget", forget: "forget", r: "rename", rename: "rename" };

function jjViolation(args, branches) {
  const [verb, action, ...rest] = subcommand(args, ["-R", "--repository", "--config", "--config-file", "--at-op", "--at-operation", "--color"]);
  if (verb === "git" && action === "push") {
    if (rest.some((arg) => ["--all", "--tracked", "--deleted"].includes(arg))) return ["pushes every tracked bookmark", null];
    const named = [];
    for (let i = 0; i < rest.length; i += 1) {
      const arg = rest[i];
      if (["-b", "--bookmark", "--named"].includes(arg)) named.push(rest[i + 1] ?? "");
      else if (/^--(?:bookmark|named)=/.test(arg)) named.push(arg.slice(arg.indexOf("=") + 1));
      else if (["-c", "--change", "-r", "--revisions"].includes(arg)) named.push("");
    }
    if (!named.length) return ["pushes tracked bookmarks, which include the integration branch", null];
    const hit = named.map((name) => name.split("=")[0]).find((name) => branches.includes(name));
    return hit ? [`pushes ${hit}`, hit] : null;
  }
  if ((verb === "bookmark" || verb === "b") && BOOKMARK_ACTIONS[action]) {
    const hit = rest.find((arg) => branches.includes(arg));
    return hit ? [`${BOOKMARK_ACTIONS[action]}s the ${hit} bookmark`, hit] : null;
  }
  return null;
}

/**
 * Why this shell line bypasses landing (or, for `releaseBranch`, release) in a
 * repository guarding these branches, or null.
 */
export function landingBypass(line, branches, releaseBranch = null) {
  for (const [program, ...args] of simpleCommands(line)) {
    const name = program.split("/").pop();
    const violation = name === "git" ? gitViolation(args, branches)
      : name === "jj" ? jjViolation(args, branches)
      : name === "gh" && args[0] === "pr" && args[1] === "merge" ? ["merges a pull request into the integration branch", null]
      : null;
    if (violation) return `This command ${violation[0]}. ${releaseBranch && violation[1] === releaseBranch ? RELEASE : LAND}`;
  }
  return null;
}

/** Claude Code hook input → a deny decision, or null to let the call proceed. */
export async function landingGuardDecision(input) {
  if (input?.tool_name !== "Bash" || typeof input.tool_input?.command !== "string") return null;
  const governed = await governance(input.cwd ?? process.cwd());
  const bypass = governed && landingBypass(input.tool_input.command, governed.branches, governed.release);
  const reason = bypass && governed.retired ? `${bypass} ${governed.retired}.` : bypass;
  return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } } : null;
}
