# slipway

Harness-neutral JJ workspace and landing tool. One tagged artifact is both the
`slipway` CLI and a library.

slipway was extracted from `pechhe/peach-pi` at `37a32367` (the landing closure in
`packages/pi-client/src/lib`, its CLI and its tests), with that history preserved.
It behaves like the `peach-workspace` it came from, under neutral names: since
v1.0.0 it keeps its state under `~/.slipway` and retires `peach-workspace` (see
[State and cutover](#state-and-cutover)), and since v1.1.0 only `slipway.json` and
the `SLIPWAY_*` environment names exist. See [CHANGELOG.md](CHANGELOG.md).

## State and cutover

| What | Location |
| --- | --- |
| Landing state, locks, verification slots, post-land and post-integration records | `~/.slipway/state` |
| Checkout mode (`slipway mode`) | `~/.slipway/mode.json` |
| New isolated workspaces | `~/.slipway/workspaces` |
| Cutover record | `~/.slipway/cutover.json` |

Before v1.0.0 these lived in `~/.pi/agent/workspace-state`,
`~/.pi/agent/workspace-mode.json` and `~/.pi/workspaces`. On a machine that still
has that state, every command except `status` and `cutover` refuses, and so does
the library's state access, until `slipway cutover` has run once. Old and new code
therefore never write separate lock stores.

`slipway cutover`:

1. Refuses, naming each holder, while any landing transaction, verification slot
   (or a landing waiting for one), Direct primary-checkout writer, post-land run or
   post-integration run is held or live. Nothing changes.
2. Moves `~/.pi/agent/workspace-state` to `~/.slipway/state` and the mode file to
   `~/.slipway/mode.json`, by rename, or across devices by copy, verify, then delete.
   Workspaces stay where they are: those under `~/.pi/workspaces` keep working at
   their recorded paths, through landing and cleanup.
3. Replaces `~/.pi/agent/bin/peach-workspace` and `~/.pi/agent/lib/peach-workspace.mjs`,
   where they exist, with stubs. The CLI stub prints the `slipway` command to run and
   exits 1. The library stub throws on import, naming `@pechhe/slipway`.
4. Writes `~/.slipway/cutover.json`. Running `slipway cutover` again is a no-op.

`slipway cutover --check` reports what would block or move without changing
anything.

The library stub stops anything that still imports
`~/.pi/agent/lib/peach-workspace.mjs`: today that is Pi's installed `pi` launcher
and its `jj-workspace` extension, which fail at startup with the stub's message.
Re-running peach-pi's `bun run install:vanilla-pi` rewrites the stubs as shims that
delegate to the globally installed slipway. That is safe once the global install
is v1.0.0 or later, because the shims then share `~/.slipway`. peach-pi stops
writing the shims once Pi imports slipway directly. Cut over every machine that
runs workspaces, and never sync `~/.slipway/state` or `~/.slipway/workspaces`
between machines: they are per-machine lock stores.

## Repository config

A repository's landing policy is `slipway.json` at its root. The pre-v1.1.0 path
`.peach/execution.json` is no longer read: a repository (or a commit being landed
or finalized) that has only that file is refused with a message naming
`slipway.json`. Rename it. Once `slipway.json` exists, a leftover old file is
ignored. The landing guard keeps guarding a repository that has only the old file
(its declared branch, `main` and `master`), and its denial names `slipway.json`.

Workspaces are named by a project code: `projectCode` in `slipway.json` (2-8
lowercase letters or digits) when declared, else two letters derived from the
checkout folder (`peach-pi` → `pp`, `slipway` → `sl`). Declare it when the folder
name may change, so existing `ys-412`-style names stay stable.

## Environment contract

| Name | Set for |
| --- | --- |
| `SLIPWAY_POST_LAND_BASE`, `SLIPWAY_POST_LAND_COMMIT` | Post-land verification commands. |
| `SLIPWAY_VERIFICATION_SLOT` | Commands running inside the held verification slot. Set to `held`, it lets a nested landing pass through. |
| `SLIPWAY_FINALIZATION_COMMIT`, `_KEY`, `_TARGET` | Post-integration finalization commands and target probes. A policy's `environmentKeys` may not start with `SLIPWAY_FINALIZATION_`. |

slipway reads `SLIPWAY_COMMAND_TIMEOUT_MS`, the per-command timeout for jj, git
and gh. The pre-v1.1.0 Peach environment names are neither set nor read.

## Install

Releases are git tags. Nothing is published to npm. The unscoped `slipway` name
there belongs to an unrelated package.

```sh
bun add -g github:pechhe/slipway#v1.11.0
slipway status
```

The repository is public, so the `github:` tag form needs no authentication.

Installing leaves `~/.pi/agent` alone. Only `slipway cutover` replaces the old
`peach-workspace` entry points there.

## CLI

`slipway <command>` offers every `peach-workspace` command with the same behaviour,
plus `cutover` and what a Claude Code `WorktreeCreate`/`WorktreeRemove` hook needs without library
imports (`start --integration --issue <n> --json`, `remove <path>`):

| Command | Effect |
| --- | --- |
| `status` | Mode, current workspace, integration checkout, landing and post-land state (JSON). |
| `mode [isolated\|direct]` | Read or write the checkout mode. |
| `list` | Workspaces with their state, Issue and retained material. |
| `pool [refill]` | Show ready spare workspaces, or provision one. |
| `prune --empty` | Remove empty workspaces. |
| `attach-issue <n>` | Bind the current workspace to Issue `n`. |
| `start "task"` | Assign an isolated workspace for a task and print its path. A new workspace is based on the integration branch freshly fetched from the declared remote (best effort: offline, it starts from the local branch). |
| `start [--integration] [--issue <n>] [--refill] [--json] ["task"]` | `--integration` allocates from the integration checkout even inside a workspace; `--issue` creates or resumes that Issue's workspace (the task defaults to `Issue #<n>`); `--refill` then starts a background spare refill; `--json` prints one JSON object (`workspacePath`, `workspaceName`, `integrationRoot`, `issueNumber`, `created`, `reused`, `pooled`, `refill`) and sends all install output to stderr. |
| `preview` | Diffstat of what a landing would integrate. |
| `land [--local-only] [--direct]` | Verify, integrate and publish the current workspace (or, with `--direct`, the primary checkout). |
| `release [--confirm <commit>] [--migrations-ready]` | Plan a promotion of the integration branch to the declared release branch, or verify and publish the confirmed candidate (see [Release](#release)). |
| `cleanup [path]` | Remove the current (or given) workspace once it has landed. |
| `remove <path>` | Remove the workspace at `path` if it has landed or is untouched; otherwise keep it and exit 1. |
| `guard` | Claude Code PreToolUse landing guard (reads the tool call on stdin). It denies moving or pushing the integration branch outside `land`, and a declared release branch outside `release`. |
| `cutover [--check]` | Move pre-v1.0.0 state to `~/.slipway` once and retire `peach-workspace` (see [State and cutover](#state-and-cutover)). |

## Release

A repository that declares a `releaseBranch` in `slipway.json` promotes its
integration branch to it only through `slipway release`:

```json
{ "integrationBranch": "develop", "releaseBranch": "master",
  "requiredReleaseVerification": [{ "executable": "bun", "args": ["run", "check:static"] }] }
```

`requiredReleaseVerification` takes the same command shape as
`requiredLocalVerification`. A release branch without it is refused; declare `[]`
to release without checks. The policy that applies is the one committed in the
candidate.

1. `slipway release` fetches and plans: the candidate (the integration branch on
   the remote), the base (the release branch on the remote), the commits between
   them, the declared checks, and any files under
   `migrationFinalization.artifactPaths` in that range. It publishes nothing.
   `halfBuiltSpecs` lists each open Spec (the open, non-`programme` parent Issue of
   an Issue a commit in the range served, by its `Issue:` trailer or `(#N)`) with
   its closed and total Tickets, so the approver sees a partly delivered feature.
   It only warns. Without a GitHub remote, or when `gh` cannot answer, it reads
   `{ "checked": false, "reason": … }` and the release goes ahead; `--confirm`
   checks again.
2. After explicit human approval of that candidate, `slipway release --confirm
   <commit>` checks the exact commit out on its own under
   `~/.slipway/state/releases/checkouts`, prepares its dependencies and runs the
   checks inside the repository's release slot, which it holds until it has
   published. Landing continues while a release verifies. The candidate must
   already be published on the integration branch.

   Concurrent confirms coalesce rather than refuse. Candidates sit on the linear
   integration branch, so of any two one contains the other, and releasing the
   newer ships both. A confirm made while another release runs waits for the slot,
   printing what it waits for (`[release] waiting for release 16bea7013436
   (contains 5b4569ebb74d)`, or `… to finish before …` when its own candidate is
   newer). It stands aside for any waiting confirm whose candidate contains its
   own, so of several waiters only the newest verifies. As soon as the release
   branch contains its candidate (the release it waited for published), or when
   it takes the slot and a fresh fetch shows that, it returns `"status":
   "released_by"` with the release `merge` that shipped it and that merge's
   candidate as `releasedBy`, without verifying. Otherwise, holding the slot, it
   plans again against the moved base and verifies and publishes its own
   candidate, so when the release it waited for fails, an older waiter still
   runs. Each session only ever verifies the commit it was approved for. A
   holder or waiter stops counting once its process is gone or, for a waiter,
   once it has not polled for a minute; a dead holder's lock goes stale after a
   minute. A confirm whose candidate is already released when it plans returns
   `"status": "up_to_date"`.
3. It builds the merge `Release <integration> to <release>` (parents: base, then
   candidate; a `Release-Candidate:` trailer) and refuses unless the merge is
   conflict-free and its tree is the candidate's, so a release branch with changes
   the integration branch lacks is refused rather than merged.
4. It pushes the release branch, refusing if the remote moved since the plan, and
   records the release in `~/.slipway/state/releases`.

`land` and `release --confirm` each append one line to
`~/.slipway/state/metrics/landings.jsonl` or `releases.jsonl`: stage durations in
milliseconds (`queued` is time waiting for another landing's slot), the outcome,
and for a release its verification time.

A release whose range carries migration artifacts also needs `--migrations-ready`:
apply those migrations where the release branch deploys first. slipway never
migrates a release environment itself.

## Library

```js
import { createWorkspace, landWorkspace, workspaceContext } from "@pechhe/slipway";
```

`@pechhe/slipway` and `@pechhe/slipway/delivery` export the same public entry,
`src/lib/peach-workspace.mjs`, typed by `peach-workspace.d.mts`. It covers
workspaces, landing and its verification, repository policy and post-integration
finalization, plus the process and text utilities that hosts share. Other
modules under `src/lib` are internal, and `bun run check` enforces that the
`src/` closure imports only itself, Node built-ins, `effect` and `proper-lockfile`,
with no cycles. A host that brokers child processes injects its broker with
`setProcessBroker`. Before the cutover, any library call that reads or writes
state rejects with an error whose `code` is `SLIPWAY_CUTOVER_REQUIRED`;
`cutoverPending()` reports that state and `cutover()` runs the cutover.

## Development and landing

slipway lands its own changes through `slipway land` from an isolated JJ workspace, under its own
`slipway.json`.

If a concurrent publisher leaves the integration bookmark conflicted after an
isolated landing, rerun `slipway land` from that preserved workspace. Recovery
accepts only its exact recorded artifact and the declared remote's published tip,
with matching committed policies and an unchanged workspace. It retains the
earlier receipt, takes the published tip as the base, and rebases and verifies the
candidate again before publication. Extra heads, policy disagreement or later
workspace edits require reconciliation. An interrupted recovery remains retryable.
Verification checks run with the working-copy revision on the exact candidate,
including retries that started on an empty continuation child.

- **Per landing**, the fast static gate runs: `bun install --frozen-lockfile`,
  `bun run check` (Oxlint and the closure boundary) and `bun run typecheck`. No
  test suite runs per landing.
- **At release**, `bun run verify:release` runs the complete suite (`bun run test`)
  against the exact commit to be tagged. It prints that commit and exits non-zero
  on failure. Tag only a commit it passed. To trace a release failure to its
  landing, bisect `<last tag>..main` and read the commit's `Issue:` trailer.

Every Vitest file runs under its own disposable `HOME`
(`scripts/vitest-hermetic-env.mjs`). `scripts/hermetic-home-guard.mjs` fails a test
that would otherwise write the real `~/.slipway` or `~/.pi`. The cutover tests build
pre-v1.0.0 state in that disposable `HOME` and never touch the real one. Run a single file with
`bunx vp test tests/<file>.test.ts`.
