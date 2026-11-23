/**
 * openchamber-guard-extension OpenCode plugin entry point.
 *
 * OpenCode V2 reads the default export's `id` and `setup`. The plugin only enforces guards. It registers two hooks and
 * watches execution events:
 *
 * - `permission.evaluate`: the complete check for every rule and every covered action.
 * - `tool.execute.before`: an early gate for the `shell` tool. It runs before any permission hook, so a plugin that
 *   acts in `evaluate` cannot see a command that a command rule or a resource-free shell permission rule blocks.
 *   Permission rules that name resource globs are not judged early. Only `evaluate` enforces them.
 *
 * It registers no provider and no tool. It imports only types from `@opencode/plugin`, so it has no runtime
 * dependencies.
 */

import type { Plugin } from "@opencode/plugin"
import { setupGuards } from "./guards/index.ts"
import { createLogger } from "./log.ts"

export const PLUGIN_ID = "openchamber-guard-extension"

/** The setup steps. Tests replace them to prove the failure isolation. */
export interface PluginSteps {
  readonly setupGuards: typeof setupGuards
}

const defaultSteps: PluginSteps = { setupGuards }

export function createPlugin(steps: PluginSteps = defaultSteps): Plugin.Plugin {
  return {
    id: PLUGIN_ID,
    async setup(ctx) {
      const log = createLogger({ debug: false })
      // A setup failure is logged without the error body and does not stop OpenCode. The guards are then NOT
      // enforced, and the runtime report says `registered: false`, so the panel shows it.
      try {
        return await steps.setupGuards(ctx, log)
      } catch {
        log.error("Guards are NOT enforced: setup failed")
        return async () => {}
      }
    },
  }
}

export default createPlugin()
