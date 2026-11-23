/**
 * Development preview, not shipped. Shows the real built guard panel and status
 * section in sandboxed iframes, each driven by the mock host and an in-memory
 * guard service. No real service, model, or file is used.
 * Run: bun test/preview/serve.ts, then open http://localhost:4319/test/preview/
 */
import { PROJECT } from "../support/fixtures.ts"
import { CHILD, createFakeGuardService, guard, iso, runtime, SESSION, type FakeState } from "../support/guard-service.ts"
import { createMockHost, LIGHT_THEME, type GenerateAnswer } from "../support/mock-host.ts"

type Case = {
  label: string
  directory: string | null
  light?: boolean
  width?: number
  height: number
  guards?: Partial<FakeState>
  session?: string | null
  surface?: "panel" | "status"
}

const PUSH = guard({
  id: "g_push",
  label: "Force pushes blocked",
  summary: "Stops force pushes to any remote.",
  request: "never force push",
  message: "A guard set by the user blocks force pushes. Do not try another way. Continue with other work.",
  rules: [{ kind: "command", program: "git", subcommands: [["push"]], flags: ["--force"] }],
})
const ENV = guard({
  id: "g_env",
  label: ".env edits blocked",
  summary: "Stops edits to .env files.",
  request: "don't let the agent edit .env files",
  message: "A guard set by the user blocks edits to .env files. Continue with other work.",
  rules: [{ kind: "permission", action: "edit", resources: ["**/.env", "**/.env.*"] }],
})
const ACTIVE = { id: "a_1", guardId: "g_commits", sessionId: SESSION, scope: "session" as const, createdAt: iso(-600_000), expiresAt: null }
const ENFORCED: Partial<FakeState> = { revision: 4, guards: [guard(), PUSH, ENV], activations: [ACTIVE], runtime: runtime({ revision: 4 }) }
const NOT_ENFORCED: Partial<FakeState> = {
  revision: 4,
  guards: [guard(), PUSH],
  activations: [{ ...ACTIVE, scope: "request" }],
  lifecycle: [{ activationId: "a_1", fact: "uncertain", at: iso(), reason: "event-stream-lost", instance: "inst_1" }],
  runtime: runtime({ revision: 4, recordedAt: iso(-300_000) }),
}

const DRAFT = {
  label: "Git commits blocked",
  summary: "Stops the agent from creating git commits.",
  message: "A guard set by the user blocks git commit. Do not try another way. Continue with other work.",
  rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
}

const generate = (prompt: string): GenerateAnswer => {
  if (/after|before|\d\s*pm/i.test(prompt)) {
    return { text: JSON.stringify({ unsupported: "Guards cannot check the time of day. Ask to block git commit at all times, and release the guard when you want to commit." }) }
  }
  if (/commit/i.test(prompt)) return { text: JSON.stringify({ draft: DRAFT }) }
  return { text: JSON.stringify({ draft: { ...DRAFT, rules: [{ kind: "command", program: "/usr/bin/git" }] } }) }
}

const CASES: Case[] = [
  { label: "Enforced, one active", directory: PROJECT, guards: ENFORCED, height: 1500 },
  { label: "Enforced (300px), light", directory: PROJECT, guards: ENFORCED, light: true, width: 300, height: 1700 },
  { label: "Not enforced, inherited request (300px)", directory: PROJECT, guards: NOT_ENFORCED, session: CHILD, width: 300, height: 1500 },
  { label: "No session", directory: PROJECT, guards: ENFORCED, session: null, height: 1200 },
  { label: "No project open", directory: null, guards: ENFORCED, height: 1500 },
  { label: "Empty library", directory: PROJECT, guards: { guards: [], runtime: runtime() }, height: 900 },
  { label: "Damaged store (300px)", directory: PROJECT, guards: { guards: [guard()], corrupt: true }, width: 300, height: 900 },
  { label: "Damaged store, light", directory: PROJECT, guards: { guards: [guard()], corrupt: true }, light: true, width: 300, height: 900 },
  { label: "Status section", directory: PROJECT, guards: ENFORCED, surface: "status", height: 90 },
  { label: "Status section, light, not enforced", directory: PROJECT, guards: NOT_ENFORCED, session: CHILD, surface: "status", light: true, height: 110 },
]

const grid = document.getElementById("grid")!
const only = new URLSearchParams(location.search).get("case")

for (const [index, item] of CASES.entries()) {
  if (only !== null && Number(only) !== index) continue
  const figure = document.createElement("figure")
  const caption = document.createElement("figcaption")
  caption.textContent = `${index}. ${item.label}`
  const frame = document.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts")
  frame.title = item.label
  frame.style.width = `${item.width ?? 360}px`
  frame.style.height = `${item.height}px`
  frame.style.background = item.light ? LIGHT_THEME.tokens.background : "#151313"
  figure.append(caption, frame)
  grid.append(figure)

  const mock = createMockHost({ post: (data) => frame.contentWindow?.postMessage(data, "*") })
  if (item.light) mock.setTheme(LIGHT_THEME)
  const fake = createFakeGuardService(item.guards ?? { guards: [guard()] })
  mock.setService((call) => fake.handle(call))
  mock.setGenerate(async (call) => {
    await new Promise((r) => setTimeout(r, 400))
    return generate(call.prompt)
  })
  const session = item.session === undefined ? SESSION : item.session
  mock.setSession(session ? { id: session, title: "Chat", busy: false } : null)
  mock.setSurface(item.surface ?? "panel")
  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return
    const data = event.data as { type?: string }
    if (data?.type === "resize" && item.surface === "status") {
      const height = (event.data as { payload?: { height?: number } }).payload?.height
      if (typeof height === "number") frame.style.height = `${height}px`
    }
    if (data?.type === "hello") {
      mock.ready(item.directory)
      return
    }
    mock.receive(event.data)
  })
  frame.src = item.surface === "status" ? "/panel/status.html" : "/panel/index.html"
}
