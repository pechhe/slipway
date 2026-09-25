import { createHash } from "node:crypto";
import path from "node:path";
import { runBoundedProcess, sanitizedProcessEnv } from "./bounded-process.mjs";

export const EXACT_COMMIT = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
export const publicationDigest = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Native authority retains normal credential routing; only host adapters supply a host-owned environment. */
export function publicationEnvironment() {
  return { ...sanitizedProcessEnv(), ...(process.env.SSH_AUTH_SOCK ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK } : {}),
    GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" };
}

export class PublicationFailure extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export function publicationIO(gitDirectory, environment, abortSignal) {
  async function run(args, accepted = [0], limit = 128 * 1024) {
    const result = await runBoundedProcess({ executable: "git",
      args: ["--git-dir", gitDirectory, ...args], cwd: gitDirectory,
      env: { ...environment(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, abortSignal,
      timeoutMs: 60_000, maxOutputBytes: limit });
    if (!accepted.includes(result.exitCode) || result.timedOut || result.cancelled || result.signal
      || result.error || result.stdoutTruncated || result.stderrTruncated) {
      throw new PublicationFailure(result.timedOut || result.cancelled ? "remote_outcome_unknown" : "git_operation_failed",
        "Source publication Git " + (args.find((arg) => !arg.startsWith("-")) ?? "operation")
          + " failed; check network, credentials, branch protection and command availability");
    }
    return result;
  }
  async function destination(remote) {
    const result = await run(["remote", "get-url", "--push", "--all", remote]);
    const urls = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (urls.length !== 1 || /[\x00-\x20]/.test(urls[0]) || urls[0].startsWith("-") || urls[0].includes("::")) {
      throw new PublicationFailure("ambiguous_push_destination", "Publication requires one unambiguous push destination");
    }
    const url = urls[0];
    if (!path.isAbsolute(url) && !/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(url) && !/^[^/]+:[^/].*/.test(url)) {
      throw new PublicationFailure("ambiguous_push_destination", "Publication requires an absolute local destination or explicit remote URL");
    }
    return { url, digest: publicationDigest(url) };
  }
  async function ancestor(older, newer) {
    return (await run(["merge-base", "--is-ancestor", older, newer], [0, 1])).exitCode === 0;
  }
  async function remoteHead(url, ref) {
    const result = await run(["ls-remote", "--refs", "--exit-code", "--", url, ref], [0, 2]);
    const lines = result.stdout.trim().split(/\r?\n/).filter(Boolean);
    if (result.exitCode === 2 || lines.length !== 1) {
      throw new PublicationFailure("remote_ref_missing", "Configured remote integration ref is missing or ambiguous");
    }
    const [sha, name] = lines[0].split(/\s+/);
    if (!EXACT_COMMIT.test(sha) || name !== ref) {
      throw new PublicationFailure("remote_ref_invalid", "Remote integration ref returned invalid identity evidence");
    }
    // Import only the observed object. Never consult shared FETCH_HEAD or change JJ/tracking bookmarks.
    const exists = await run(["cat-file", "-e", sha + "^{commit}"], [0, 1, 128]);
    if (exists.exitCode !== 0) {
      await run(["-c", "fetch.writeCommitGraph=false", "fetch", "--no-tags", "--no-write-fetch-head",
        "--no-recurse-submodules", "--refmap=", "--", url, sha]);
    }
    await run(["cat-file", "-e", sha + "^{commit}"]);
    return sha;
  }
  async function outgoing(from, target) {
    const result = await run(["log", "--no-notes", "--format=%H%x00%an%x00%ae%x00%cn%x00%ce%x00%B%x00",
      from + ".." + target], [0], 2 * 1024 * 1024);
    const fields = result.stdout.split("\0");
    if (fields.pop()?.trim()) throw new PublicationFailure("invalid_history", "Outgoing commit metadata is incomplete");
    if (fields.length % 6) throw new PublicationFailure("invalid_history", "Outgoing commit metadata is incomplete");
    const commits = [];
    for (let index = 0; index < fields.length; index += 6) {
      const [sha, author, email, committer, committerEmail, message] = fields.slice(index, index + 6).map((value) => value.trim());
      if (!EXACT_COMMIT.test(sha) || !author || !email || !committer || !committerEmail || !message) {
        throw new PublicationFailure("unpublishable_commit", "Outgoing commit " + sha.slice(0, 12) + " has missing author, committer or description metadata");
      }
      commits.push(sha);
    }
    return { outgoingCount: commits.length, outgoingDigest: publicationDigest(commits) };
  }
  async function push(url, ref, target) {
    // Explicit URL/refspec plus negative options prevent mirror, tags and submodule defaults adding effects.
    return runBoundedProcess({ executable: "git", args: ["--git-dir", gitDirectory,
      "-c", "push.followTags=false", "push", "--porcelain", "--no-follow-tags", "--recurse-submodules=no",
      "--", url, target + ":" + ref], cwd: gitDirectory,
      env: { ...environment(), GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" }, abortSignal,
      timeoutMs: 120_000, maxOutputBytes: 32 * 1024 });
  }
  return { run, destination, ancestor, remoteHead, outgoing, push };
}
