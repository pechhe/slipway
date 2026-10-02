# Changelog

## v0.2.1

Ports pechhe/peach-pi#1003 (`92090ecc4`), which landed in peach-pi after the
v0.1.0 extraction (pechhe/slipway#1).

- **Cleanup:** a workspace whose post-integration step failed is released when the
  declared remote already contains its artifact, because a later landing
  published it after running its own step. `cleanup` reports the superseded
  record (status, attempt, reason), and `cleanupLandedWorkspace` returns it as
  `supersededPostIntegration`. A failure that is unpublished, or has no declared
  remote, still keeps the workspace.
- **Land:** retrying `land` in that state says to run `cleanup` instead of
  rerunning land.

## v0.2.0

Neutral names, read and set alongside the Peach names (pechhe/peach-pi#997).

- **Config:** `slipway.json` at the repository root is the landing policy, with
  the same schema as `.peach/execution.json`. When both exist, `slipway.json`
  wins. A repository with only `.peach/execution.json` still works, and slipway
  prints a one-line deprecation warning to stderr naming `slipway.json`. This
  applies to working-file reads, the landing guard, and exact-commit reads
  during landing and finalization.
- **Environment:** verification commands receive `SLIPWAY_POST_LAND_BASE`,
  `SLIPWAY_POST_LAND_COMMIT`, `SLIPWAY_VERIFICATION_SLOT`,
  `SLIPWAY_FINALIZATION_COMMIT`, `SLIPWAY_FINALIZATION_KEY` and
  `SLIPWAY_FINALIZATION_TARGET` alongside the existing `PEACH_*` names. A policy's
  `environmentKeys` may not start with `SLIPWAY_FINALIZATION_` or
  `PEACH_FINALIZATION_`. slipway reads `SLIPWAY_COMMAND_TIMEOUT_MS`, falling back
  to `PEACH_WORKSPACE_COMMAND_TIMEOUT_MS`.
- **Deprecation:** the old names (`.peach/execution.json`, the `PEACH_*`
  verification environment and `PEACH_WORKSPACE_COMMAND_TIMEOUT_MS`) are removed
  in a later release. Move repository config to `slipway.json` and switch
  verification scripts to the `SLIPWAY_*` names before then.
- **Not changed:** state still lives under `~/.pi`. slipway's own repository keeps
  `.peach/execution.json` until the installed landing tools read `slipway.json`.

## v0.1.0

The `peach-workspace` landing closure extracted from pechhe/peach-pi `37a32367`
with its history, behaviour-identical, plus hook-facing CLI commands.
