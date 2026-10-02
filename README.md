# slipway

Harness-neutral JJ workspace and landing tool. One tagged artifact is both the
`slipway` CLI and a library.

slipway was extracted from `pechhe/peach-pi` at `37a32367` (the landing closure in
`packages/pi-client/src/lib`, its CLI and its tests), with that history preserved.
Until the later migration releases, it behaves exactly like the `peach-workspace`
it came from. It uses the same state under `~/.pi` (`~/.pi/workspaces`,
`~/.pi/agent/workspace-state`, `~/.pi/agent/workspace-mode.json`), the same
`.peach/execution.json` repository policy, and the same `PEACH_*` environment
contract for verification commands.

## Install

Releases are git tags. Nothing is published to npm. The unscoped `slipway` name
there belongs to an unrelated package.

```sh
bun add -g github:pechhe/slipway#v0.1.0
slipway status
```

The repository is private, so the installing account needs GitHub access to it.

## CLI

`slipway <command>` offers every `peach-workspace` command with the same behaviour,
plus what a Claude Code `WorktreeCreate`/`WorktreeRemove` hook needs without library
imports (`start --integration --issue <n> --json`, `remove <path>`):

| Command | Effect |
| --- | --- |
| `status` | Mode, current workspace, integration checkout, landing and post-land state (JSON). |
| `mode [isolated\|direct]` | Read or write the checkout mode. |
| `list` | Workspaces with their state, Issue and retained material. |
| `pool [refill]` | Show ready spare workspaces, or provision one. |
| `prune --empty` | Remove empty workspaces. |
| `attach-issue <n>` | Bind the current workspace to Issue `n`. |
| `start "task"` | Assign an isolated workspace for a task and print its path. |
| `start [--integration] [--issue <n>] [--refill] [--json] ["task"]` | `--integration` allocates from the integration checkout even inside a workspace; `--issue` creates or resumes that Issue's workspace (the task defaults to `Issue #<n>`); `--refill` then starts a background spare refill; `--json` prints one JSON object (`workspacePath`, `workspaceName`, `integrationRoot`, `issueNumber`, `created`, `reused`, `pooled`, `refill`) and sends all install output to stderr. |
| `preview` | Diffstat of what a landing would integrate. |
| `land [--local-only] [--direct]` | Verify, integrate and publish the current workspace (or, with `--direct`, the primary checkout). |
| `cleanup [path]` | Remove the current (or given) workspace once it has landed. |
| `remove <path>` | Remove the workspace at `path` if it has landed or is untouched; otherwise keep it and exit 1. |
| `guard` | Claude Code PreToolUse landing guard (reads the tool call on stdin). |

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
`setProcessBroker`.

## Development and landing

slipway lands its own changes through `slipway land` (or the installed
`peach-workspace land`) from an isolated JJ workspace, under `.peach/execution.json`.

- **Per landing**, the fast static gate runs: `bun install --frozen-lockfile`,
  `bun run check` (Oxlint and the closure boundary) and `bun run typecheck`. No
  test suite runs per landing.
- **At release**, `bun run verify:release` runs the complete suite (`bun run test`)
  against the exact commit to be tagged. It prints that commit and exits non-zero
  on failure. Tag only a commit it passed. To trace a release failure to its
  landing, bisect `<last tag>..main` and read the commit's `Issue:` trailer.

Every Vitest file runs under its own disposable `HOME`
(`scripts/vitest-hermetic-env.mjs`). `scripts/hermetic-home-guard.mjs` fails a test
that would otherwise write the real `~/.pi`. Run a single file with
`bunx vp test tests/<file>.test.ts`.
