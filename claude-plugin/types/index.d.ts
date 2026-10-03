export type Mode = 'default' | 'isolated' | 'direct'

export type Workspace = {
  name: string
  path: string
  /** The primary checkout; `slipway list` runs there, since a landed workspace may be gone. */
  integrationRoot?: string
  /** `slipway list`'s label: `landed`, `unlanded`, `empty`, `integration`, with any `· issue #n`. */
  label: string
  /** `landing.phase` from `slipway status --json`, when a land has started. */
  phase?: string
  /** Post-land checks of this workspace's landed commit: `passed`, `failed`, `running`. */
  postLand?: string
}

declare module 'claude-code' {
  interface PluginState {
    slipway: {
      workspace: Workspace | null
      mode: Mode
      machineMode: string | null
      sentMode: Mode
      isRepo: boolean
    }
  }
}
