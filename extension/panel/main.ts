/**
 * Panel entry. Connects to OpenChamber and follows the current location and session.
 *
 * It reads and changes guards only through this extension's local service, and
 * only after a user click. It sends the user's request to the Small Model only
 * when the user selects Generate. It never reads files, sends a prompt to a chat
 * session, or changes sessions.
 */
import { connectHost, type HostClient } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"

import { createGuardsController, type GuardsController } from "./guards/controller.ts"
import { createGuardService } from "./guards/service.ts"
import { createGuardsView, type GuardsView } from "./guards/view.ts"
import { createView, type View } from "./view.ts"

/** How often the panel reads guard state while it is open and visible. The plugin reports about this often. */
export const GUARD_POLL_MS = 15_000
/** How long the panel waits for OpenChamber's first message. */
export const CONNECT_TIMEOUT_MS = 5_000

export type StartOptions = {
  root: HTMLElement
  host?: HostClient
  win?: Window
  guardPollMs?: number
  connectTimeoutMs?: number
  /** Test seam for the clock. */
  now?: () => number
  /** Test seam for operation IDs. */
  opId?: () => string
}

export type Panel = {
  view: View
  guards: GuardsController
  guardsView: GuardsView
  dispose: () => void
}

export const startPanel = (options: StartOptions): Panel => {
  const win = options.win ?? window
  const doc = win.document
  let locale = "en"
  let disposed = false

  const embedded = win.parent !== win
  const host = options.host ?? connectHost()
  const view = createView({ root: options.root })

  let guards: GuardsController
  const guardsView = createGuardsView({
    root: view.guardsRoot,
    controller: () => guards,
    locale: () => locale,
    ...(options.now ? { now: options.now } : {}),
  })
  guards = createGuardsController({
    service: createGuardService({ serviceRequest: (request) => host.serviceRequest(request) }),
    generate: (request) => host.generate(request),
    onChange: (state) => {
      guardsView.render(state)
      view.setActiveCount(guardsView.activeCount())
    },
    ...(options.opId ? { opId: options.opId } : {}),
  })
  guardsView.render(guards.state())

  let ready = false
  let directory: string | null = null
  let sessionId: string | null = null
  const connectTimer = win.setTimeout(() => {
    if (!ready && !disposed) view.noHost(embedded ? "no-answer" : "not-embedded")
  }, options.connectTimeoutMs ?? CONNECT_TIMEOUT_MS)
  if (!embedded && !options.host) {
    win.clearTimeout(connectTimer)
    view.noHost("not-embedded")
  }

  const stopReady = host.onReady((ctx) => {
    applyHostReady(ctx, doc.documentElement)
    locale = ctx.locale || "en"
    ready = true
    win.clearTimeout(connectTimer)
    view.connected()
    directory = ctx.directory
    sessionId = ctx.session?.id ?? null
    view.setPlace(directory)
    // `onDirectory` also fires for each snapshot; the controller ignores a repeat.
    guards.setContext({ directory, sessionId })
  })
  const stopDirectory = host.onDirectory((next) => {
    if (!ready) return
    directory = next
    view.setPlace(directory)
    guards.setContext({ directory, sessionId })
  })
  const stopSession = host.onSession((session) => {
    if (!ready) return
    sessionId = session?.id ?? null
    guards.setContext({ directory, sessionId })
  })
  // A Generate answer that arrived after an earlier frame closed.
  const stopLate = host.onLateGenerateResult((late) => guards.lateGeneration(late))

  const visible = () => doc.visibilityState !== "hidden"
  const guardPoll = win.setInterval(() => {
    if (visible() && ready) guards.refresh()
  }, options.guardPollMs ?? GUARD_POLL_MS)

  const onVisibility = () => {
    if (visible() && ready) guards.refresh()
  }
  doc.addEventListener("visibilitychange", onVisibility)

  const dispose = () => {
    if (disposed) return
    disposed = true
    win.clearTimeout(connectTimer)
    win.clearInterval(guardPoll)
    doc.removeEventListener("visibilitychange", onVisibility)
    stopReady()
    stopDirectory()
    stopSession()
    stopLate()
    // The guard view stays on screen as it is; the controller stops and the
    // header's SDK handles (badge, connection notice) are released.
    guards.dispose()
    view.dispose()
    host.dispose()
  }
  win.addEventListener("pagehide", dispose, { once: true })

  return { view, guards, guardsView, dispose }
}

const root = typeof document !== "undefined" ? document.getElementById("root") : null
if (root && !(globalThis as { __GUARDS_NO_AUTOSTART__?: boolean }).__GUARDS_NO_AUTOSTART__) {
  startPanel({ root })
}
