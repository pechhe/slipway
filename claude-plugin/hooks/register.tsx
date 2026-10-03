import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Mode, Workspace } from '../types'

const workspace = atom({ plugin: 'slipway', key: 'workspace' } as const, null)
const mode = atom({ plugin: 'slipway', key: 'mode' } as const, 'default')
const machineMode = atom({ plugin: 'slipway', key: 'machineMode' } as const, null)
const sentMode = atom({ plugin: 'slipway', key: 'sentMode' } as const, 'default')
const isRepo = atom({ plugin: 'slipway', key: 'isRepo' } as const, false)

const WORKSPACE_PATH = /\/[^\s'"`:]*\/\.(?:pi|slipway)\/workspaces\/[A-Za-z0-9._-]+/g
const LAND = /\bslipway\s+land\b/
const START = /\bslipway\s+start\b/
const LISTING = /\bslipway\s+(?:list|prune|cleanup|remove|pool)\b/

const MODE_CONTEXT: Record<Exclude<Mode, 'default'>, string> = {
  direct:
    'Slipway mode for this thread, set by the user with the slipway plugin toggle: Direct. ' +
    'Work in the primary checkout, preserve existing changes, and land with `slipway land --direct`. ' +
    'This does not change the machine-wide `slipway mode`.',
  isolated:
    'Slipway mode for this thread, set by the user with the slipway plugin toggle: Isolated. ' +
    'Create or resume an owned JJ workspace (`slipway start --integration --json`) before editing, ' +
    'and land with `slipway land` from that workspace.',
}

type Host = EngineInterface

let isRefreshing = false

function lastMatch(text: string): string | undefined {
  return text.match(WORKSPACE_PATH)?.at(-1)
}

async function slipway($: Host, args: readonly string[], cwd: string) {
  return $.process.run(
    ['/bin/sh', '-c', 'exec "$HOME/.bun/bin/slipway" "$@"', 'slipway', ...args],
    { cwd, timeoutMs: 20_000 },
  )
}

function statusLine(ws: Workspace | null): string | undefined {
  if (ws === null) return undefined
  const isLanded = ws.label.startsWith('landed')
  const head = isLanded ? `✓ ${ws.name} landed` : `⛵ ${ws.name} · ${ws.phase ?? ws.label}`
  const issue = isLanded ? ws.label.replace(/^landed/, '') : ''
  const post = ws.postLand !== undefined && ws.postLand !== 'passed' ? ` · post-land ${ws.postLand}` : ''

  return `${head}${issue}${post}`
}

async function refresh($: Host, path: string, isLand = false) {
  if (isRefreshing) return
  isRefreshing = true
  try {
    const before = await read($, workspace)
    const known = before?.path === path ? before.integrationRoot : undefined
    const status = await slipway($, ['status', '--json'], path).catch(() => undefined)
    const facts = status?.exitCode === 0 ? JSON.parse(status.stdout) : {}
    const integrationRoot: string | undefined = facts.integration?.root ?? known
    const listed = await slipway($, ['list'], integrationRoot ?? path)
    const row = listed.stdout
      .split('\n')
      .map(line => line.split('\t'))
      .find(cols => cols[1] === path)
    if (row === undefined) return

    const landing = facts.landing
    const post = facts.postLand
    const next: Workspace = {
      name: row[0] ?? path,
      path,
      integrationRoot,
      label: row[2] ?? 'unknown',
      phase: landing?.phase !== undefined && landing.phase !== 'landed' ? landing.phase : undefined,
      postLand:
        post !== undefined && landing?.artifactCommitId === post.commit ? post.status : undefined,
    }
    await update($, workspace, () => next)
    if (typeof facts.mode === 'string') await update($, machineMode, () => facts.mode)
    $.ui.status(statusLine(next))

    const wasLanded = before?.path === path && before.label.startsWith('landed')
    if (next.label.startsWith('landed') && (isLand || (!wasLanded && before?.path === path))) {
      $.ui.toast(`Landed ${next.name}${next.label.replace(/^landed/, '')}`, { timeoutMs: 8000 })
    }
  } catch {
    // slipway missing or not a JJ repo: leave the last known state.
  } finally {
    isRefreshing = false
  }
}

async function track($: Host, path: string | undefined, isLand = false) {
  if (path === undefined) return
  const current = await read($, workspace)
  if (current?.path !== path || isLand) await update($, isRepo, () => true)
  await refresh($, path, isLand)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'slipway',
      description: 'Show this thread’s Slipway workspace; `/slipway direct|isolated|default` sets the thread’s mode',
    })

    const root = await $.session.root()
    const hasJj = await $.fs.stat(`${root}/.jj`).then(s => s.kind === 'dir').catch(() => false)
    if (hasJj) {
      await update($, isRepo, () => true)
      const facts = await slipway($, ['mode'], root).catch(() => undefined)
      const machine = facts?.stdout.trim()
      if (facts?.exitCode === 0 && machine) await update($, machineMode, () => machine)
    }

    const ws = await read($, workspace)
    if (ws !== null) $.ui.status(statusLine(ws))
    await track($, lastMatch(root))

    $.clock.every(60_000, () => {
      void read($, workspace).then(current => {
        if (current !== null && !current.label.startsWith('landed')) void refresh($, current.path)
      })
    })

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || LISTING.test(e.command)) return ran

    const isLand = LAND.test(e.command)
    const path = START.test(e.command)
      ? lastMatch(ran.text ?? '') ?? lastMatch(e.command)
      : lastMatch(e.command)
    const target = path ?? (isLand ? (await read($, workspace))?.path : undefined)
    await track($, target, isLand)

    return ran
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    const file = (e as { file_path?: unknown }).file_path
    if (e.tool !== 'Bash' && typeof file === 'string') await track($, lastMatch(file))

    return ran
  })

  on('prompt.submit', async ($, e, next) => {
    const chosen = await read($, mode)
    const sent = await read($, sentMode)
    if (chosen === sent) return next(e)

    await update($, sentMode, () => chosen)
    const note =
      chosen === 'default'
        ? 'Slipway mode for this thread is back to the default; follow the machine-wide `slipway mode` and the global instructions.'
        : MODE_CONTEXT[chosen]

    return next({ ...e, context: [...(e.context ?? []), note] })
  })

  on('command.run', { command: 'slipway' }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'direct' || arg === 'isolated' || arg === 'default') {
      await update($, mode, () => arg)
      await update($, isRepo, () => true)

      return { text: `Slipway mode for this thread: ${arg}. Applies from your next prompt.` }
    }

    const ws = await read($, workspace)
    if (ws !== null) await refresh($, ws.path)
    const fresh = await read($, workspace)
    const chosen = await read($, mode)
    const machine = await read($, machineMode)
    const lines = [
      fresh === null ? 'No Slipway workspace seen in this thread yet.' : `Workspace: ${fresh.name} — ${fresh.label}`,
      fresh === null ? '' : `Path: ${fresh.path}`,
      fresh?.phase === undefined ? '' : `Landing: ${fresh.phase}`,
      fresh?.postLand === undefined ? '' : `Post-land checks: ${fresh.postLand}`,
      `Mode: ${chosen === 'default' ? `default (${machine ?? 'machine setting'})` : `${chosen} (this thread)`}`,
    ]

    return { text: lines.filter(Boolean).join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || !(await read($, isRepo))) return next(e)

    const ui = $.ui.resolve(e)
    if (!('Select' in ui)) return next(e)
    const { Box, Text, Select } = ui

    const ws = await read($, workspace)
    const chosen = await read($, mode)
    const machine = await read($, machineMode)
    const line = statusLine(ws) ?? 'no workspace yet'

    return (
      <Box flexDirection="row" gap={2}>
        <Text dimColor>{line}</Text>
        <Select
          key="mode"
          label="Mode "
          value={chosen}
          options={[
            { value: 'default', label: `Default (${machine ?? 'machine'})` },
            { value: 'isolated', label: 'Isolated' },
            { value: 'direct', label: 'Direct (this thread)' },
          ]}
          onSelect={value => update($, mode, () => value as Mode)}
        />
      </Box>
    )
  })
}
