/**
 * The panel frame against a fake OpenChamber host: connection, header, theme,
 * location and session handling. The guard management itself is covered in
 * test/guards/panel-guards.test.ts. No real service, model, session, or file is used.
 */
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"

beforeAll(() => {
  GlobalRegistrator.register({ url: "https://panel.test/" })
  ;(globalThis as { __GUARDS_NO_AUTOSTART__?: boolean }).__GUARDS_NO_AUTOSTART__ = true
})
afterAll(async () => {
  await GlobalRegistrator.unregister()
})

import type { Panel } from "../panel/main.ts"
import { NOW, OTHER_PROJECT, PROJECT } from "./support/fixtures.ts"
import { CHILD, createFakeGuardService, guard, iso, SESSION, type FakeState } from "./support/guard-service.ts"
import { connectMock, findButton, text, tick } from "./support/harness.ts"
import { LIGHT_THEME } from "./support/mock-host.ts"

let panel: Panel | null = null
afterEach(() => {
  panel?.dispose()
  panel = null
})

const start = async (options: { state?: Partial<FakeState>; session?: string | null; connectTimeoutMs?: number } = {}) => {
  const { startPanel } = await import("../panel/main.ts")
  panel?.dispose()
  document.body.innerHTML = '<main id="root"></main>'
  const root = document.getElementById("root") as HTMLElement
  const { host, mock } = connectMock()
  const fake = createFakeGuardService(options.state ?? { guards: [guard()] })
  mock.setService((call) => fake.handle(call))
  const session = options.session === undefined ? SESSION : options.session
  mock.setSession(session ? { id: session, title: "Chat", busy: false } : null)
  let n = 0
  panel = startPanel({
    root,
    host,
    connectTimeoutMs: options.connectTimeoutMs ?? 10_000,
    guardPollMs: 60_000,
    now: () => NOW,
    opId: () => `op-${++n}`,
  })
  const guards = root.querySelector("#guards") as HTMLElement
  return { root, guards, mock, fake }
}

const visible = (node: Element | null) => node !== null && !(node as HTMLElement).hidden
const placeText = (root: HTMLElement) =>
  [...root.querySelector<HTMLElement>(".hdr-place")!.children].filter(visible).map((n) => n.textContent).join(" ")
const stateReads = (mock: { serviceCalls: Array<{ method: string; path: string; query?: Record<string, string> }> }) =>
  mock.serviceCalls.filter((c) => c.method === "GET" && c.path === "/state").map((c) => c.query)

describe("guard panel frame", () => {
  test("waits for OpenChamber before reading guards", async () => {
    const { root, mock } = await start()
    await tick()
    expect(placeText(root)).toBe("Connecting to OpenChamber…")
    expect(text(root)).toContain("Reading guards…")
    expect(mock.serviceCalls).toHaveLength(0)
  })

  test("says when OpenChamber never connects, and hides the guard controls", async () => {
    const { root, guards } = await start({ connectTimeoutMs: 5 })
    await new Promise((r) => setTimeout(r, 20))
    expect(text(root)).toMatch(/OpenChamber did not connect|Open this panel in OpenChamber/)
    expect(placeText(root)).toBe("Not connected")
    expect(guards.hidden).toBe(true)
  })

  test("a late connection brings the guard controls back", async () => {
    const { root, guards, mock } = await start({ connectTimeoutMs: 5 })
    await new Promise((r) => setTimeout(r, 20))
    expect(guards.hidden).toBe(true)
    mock.ready(PROJECT)
    await tick()
    expect(guards.hidden).toBe(false)
    expect(visible(root.querySelector(".slot"))).toBe(false)
    expect(text(guards)).toContain("Saved guards (1)")
  })

  test("the header names the extension and the project; the mark is decorative", async () => {
    const { root, mock } = await start()
    mock.ready(PROJECT)
    await tick()
    const title = root.querySelector(".hdr-title")!
    expect(title.textContent).toBe("Guards")
    expect(title.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true")
    expect(placeText(root)).toBe("Project example-project")
    expect(root.querySelector(".hdr-path")?.textContent).toBe(PROJECT)
  })

  test("no project open still manages guards", async () => {
    const { root, guards, mock } = await start()
    mock.ready(null)
    await tick()
    expect(placeText(root)).toBe("No project open")
    expect(stateReads(mock)).toEqual([{ sessionId: SESSION }])
    expect(text(guards)).toContain("Saved guards (1)")
  })

  test("follows the location and the session OpenChamber reports", async () => {
    const { root, mock } = await start()
    mock.ready(PROJECT)
    await tick()
    mock.directory(OTHER_PROJECT)
    await tick()
    expect(placeText(root)).toBe("Project other-project")
    mock.session({ id: CHILD, title: "Subagent", busy: true })
    await tick()
    expect(stateReads(mock)).toEqual([
      { sessionId: SESSION, directory: PROJECT },
      { sessionId: SESSION, directory: OTHER_PROJECT },
      { sessionId: CHILD, directory: OTHER_PROJECT },
    ])
  })

  test("leaving the session turns Enable off and says why", async () => {
    const { guards, mock } = await start()
    mock.ready(PROJECT)
    await tick()
    expect(findButton(guards, "Enable…")?.disabled).toBe(false)
    mock.session(null)
    await tick()
    expect(findButton(guards, "Enable…")?.disabled).toBe(true)
    expect(text(guards)).toContain("Open a chat session to enable a guard.")
  })

  test("the header counts guards active in this session", async () => {
    const { root, mock } = await start({
      state: {
        guards: [guard()],
        activations: [{ id: "a_1", guardId: "g_commits", sessionId: SESSION, scope: "session", createdAt: iso(-1000), expiresAt: null }],
      },
    })
    mock.ready(PROJECT)
    await tick()
    expect(root.querySelector(".hdr-badge")?.textContent).toBe("1 active")
    // Dispose releases the badge's SDK handle.
    panel?.dispose()
    panel = null
    expect(root.querySelector(".hdr-badge")?.childElementCount).toBe(0)
  })

  test("dispose releases the connection notice", async () => {
    const { root } = await start({ connectTimeoutMs: 5 })
    await new Promise((r) => setTimeout(r, 20))
    const notice = root.querySelector<HTMLElement>(".slot")!
    expect(notice.childElementCount).toBeGreaterThan(0)
    panel?.dispose()
    panel = null
    expect(notice.childElementCount).toBe(0)
  })

  test("applies the host theme on connect", async () => {
    const { mock } = await start()
    mock.setTheme(LIGHT_THEME)
    mock.ready(PROJECT)
    await tick()
    expect(document.documentElement.dataset.ocTheme).toBe("light")
  })

  test("has no setup report: no file reads, no model check, no report buttons", async () => {
    const { root, mock } = await start()
    mock.ready(PROJECT)
    await tick()
    expect(mock.reads).toEqual([])
    expect(mock.serviceCalls.some((c) => c.path === "/model-check")).toBe(false)
    expect(mock.generateCalls).toHaveLength(0)
    expect(findButton(root, "Check models now")).toBeNull()
    expect(findButton(root, "Reload saved report")).toBeNull()
    expect(root.querySelector("[role=tab]")).toBeNull()
    expect(text(root)).not.toMatch(/FueliX/)
  })

  test("after dispose, host messages change nothing", async () => {
    const { root, mock } = await start()
    mock.ready(PROJECT)
    await tick()
    const before = text(root)
    const calls = mock.serviceCalls.length
    panel?.dispose()
    panel = null
    mock.directory(OTHER_PROJECT)
    await tick()
    expect(text(root)).toBe(before)
    expect(mock.serviceCalls).toHaveLength(calls)
  })
})
