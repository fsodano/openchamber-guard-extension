/**
 * Guards on an isolated OpenCode server.
 *
 * Loads the shipped plugin bundle (`extension/plugin/index.js`, run `bun run plugin:build` first) as a local plugin.
 * A fixture plugin registers a mock OpenAI-compatible provider that points at a deterministic local server. A second
 * fixture plugin (`guards-probe`) only records the effect that arrives at the permission hook. The test writes
 * `store.json` as the extension service does. A fake `git` records each run, so a blocked command is proven not to
 * have executed. Fake keys only. No real model, no network beyond loopback.
 *
 * The guard plugin loads no other plugin. The probe plugin loads BEFORE the guard plugin in every rig, so it stands for
 * a plugin (such as Jev) whose `permission.evaluate` hook runs first. The guard registers an early `tool.execute.before`
 * gate for shell, which OpenCode runs before any permission hook. The tests prove only the representative cases that
 * they run: a plain and a compound `git commit` under one command rule, and a resource-free shell permission rule. In
 * those cases the blocked command never reaches the probe and never runs. They do not prove that every command that a
 * rule matches is blocked early. The early gate parses the raw command text, and OpenCode parses its own permission
 * resources, so the two can differ for other syntax. They also prove one limit: a permission rule with resource globs is
 * judged only by the `evaluate` hook, so the probe sees such a command first, and the command is still denied and never
 * runs.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseLifecycleText, resolveLifecycleViews } from "../../src/guards/lifecycle-history.ts"
import { parseLifecycleLine, parseRuntimeReport, type Activation } from "../../src/guards/schema.ts"
import { pluginEntry, repoRoot, startIsolatedServer, waitFor, type EventFeed, type IsolatedServer } from "./harness.ts"
import { startMockModel, type MockModel, type RecordedRequest } from "./mock-model.ts"

const MODEL = { providerID: "mock", id: "mock-model" } as const

const artifactDir = process.env.GUARD_ARTIFACT_DIR ?? join(tmpdir(), "opencode", `guard-integration-${Date.now()}`)
mkdirSync(artifactDir, { recursive: true })
const requestLog = join(artifactDir, "provider-requests.jsonl")
const report: Record<string, unknown> = { artifactDir }

// ---------------------------------------------------------------------------------------------------------------------
// Deterministic fake provider (OpenAI Chat Completions streaming)
// ---------------------------------------------------------------------------------------------------------------------

type Script = { tool: string; args: Record<string, unknown> } | { text: string }

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (Array.isArray(content)) return content.map((part: any) => (typeof part?.text === "string" ? part.text : "")).join("\n")
  return ""
}

function sse(model: string, script: Script): Response {
  const base = { id: "chatcmpl-probe", object: "chat.completion.chunk", created: 1_700_000_000, model }
  const frames: unknown[] =
    "tool" in script
      ? [
          {
            ...base,
            choices: [
              {
                index: 0,
                delta: {
                  role: "assistant",
                  tool_calls: [
                    { index: 0, id: `call_${Math.random().toString(36).slice(2, 10)}`, type: "function", function: { name: script.tool, arguments: JSON.stringify(script.args) } },
                  ],
                },
              },
            ],
          },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
        ]
      : [
          { ...base, choices: [{ index: 0, delta: { role: "assistant", content: script.text } }] },
          { ...base, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
        ]
  frames.push({ ...base, choices: [], usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } })
  const body = `${frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("")}data: [DONE]\n\n`
  return new Response(body, { headers: { "content-type": "text/event-stream" } })
}

interface Scenario {
  /** Tool name of the shell tool, filled in from the first request that lists tools. */
  shellTool: string
  taskTool: string
  dir: string
}
const scenario: Scenario = { shellTool: "shell", taskTool: "subagent", dir: "" }

function respond(request: RecordedRequest): Response | Promise<Response> | undefined {
  if (!request.path.endsWith("/chat/completions")) return undefined
  const body = request.body
  const model = String(body?.model ?? MODEL.id)
  appendLog(requestLog, {
    messages: (body?.messages ?? []).map((m: any) => ({ role: m.role, content: textOf(m.content).slice(0, 300), tool_calls: m.tool_calls?.map((c: any) => c.function) })),
    tools: (body?.tools ?? []).map((t: any) => t.function?.name),
  })
  const tools: any[] = body?.tools ?? []
  if (tools.length === 0) return sse(model, { text: "Probe title" }) // Title request has no tools.
  const messages: any[] = body.messages ?? []
  // The latest user message selects the scenario. Only tool results after it count, so one session can run many prompts.
  const lastUserIndex = messages.map((m) => m.role).lastIndexOf("user")
  const firstUser = textOf(messages[lastUserIndex]?.content)
  const toolResults = messages.slice(lastUserIndex + 1).filter((m) => m.role === "tool").length

  if (firstUser.includes("SCENARIO_HANG")) return new Promise<Response>(() => {}) // never answers
  // Real guard scenarios. They run a fake `git` (logs one line per run) and harmless marker commands.
  if (firstUser.includes("GSCN_ONE")) {
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: "git commit -m guarded", timeout: 20000 } })
    return sse(model, { text: "GSCN ONE DONE" })
  }
  if (firstUser.includes("GSCN_ROOT")) {
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: "git commit -m guarded", timeout: 20000 } })
    if (toolResults === 1) return sse(model, { tool: scenario.shellTool, args: { command: `echo 'git commit' > ${scenario.dir}/echo-quoted.marker`, timeout: 20000 } })
    if (toolResults === 2) return sse(model, { tool: scenario.shellTool, args: { command: `printf x > ${scenario.dir}/allowed-g-root.marker`, timeout: 20000 } })
    return sse(model, { text: "GSCN ROOT DONE" })
  }
  if (firstUser.includes("GSCN_COMPOUND")) {
    // A compound command: OpenCode passes `echo safe` and `git commit -m guarded` as separate permission resources.
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: "echo safe && git commit -m guarded", timeout: 20000 } })
    return sse(model, { text: "GSCN COMPOUND DONE" })
  }
  if (firstUser.includes("GSCN_UNGUARDED")) {
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: `printf x > ${scenario.dir}/unguarded-probe.marker`, timeout: 20000 } })
    return sse(model, { text: "GSCN UNGUARDED DONE" })
  }
  if (firstUser.includes("GSCN_PARENT")) {
    if (toolResults === 0) {
      return sse(model, { tool: scenario.taskTool, args: { description: "g child", prompt: "GSCN_CHILD run the commands", agent: "general" } })
    }
    return sse(model, { text: "GSCN PARENT DONE" })
  }
  if (firstUser.includes("GSCN_CHILD")) {
    if (toolResults === 0) return sse(model, { tool: scenario.shellTool, args: { command: "/usr/bin/env git -C . commit -m guarded", timeout: 20000 } })
    if (toolResults === 1) return sse(model, { tool: scenario.shellTool, args: { command: `printf x > ${scenario.dir}/allowed-g-child.marker`, timeout: 20000 } })
    return sse(model, { text: "GSCN CHILD DONE" })
  }
  return sse(model, { text: "UNSCRIPTED" })
}

function appendLog(file: string, entry: unknown) {
  writeFileSync(file, `${JSON.stringify(entry)}\n`, { flag: "a" })
}

function readJsonl(file: string): any[] {
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line))
}

// ---------------------------------------------------------------------------------------------------------------------
// Real guards: `setupGuards` from this repository, loaded as a local plugin on an isolated server.
// The test writes `store.json` as the extension service does. A fake `git` records each run, so a blocked command
// is proven not to have executed. The `guards-probe` plugin only records the effect that arrives at the hook.
// ---------------------------------------------------------------------------------------------------------------------

interface GuardRig {
  server: IsolatedServer
  feed: EventFeed
  mock: MockModel
  sandbox: string
  binDir: string
  probeFile: string
  guardsDir: string
  stop(): Promise<void>
}

const COMMIT_GUARD = {
  id: "g-commit",
  label: "No commits",
  summary: "Blocks git commit",
  request: "Never commit",
  message: "Guard test: git commit is blocked for this session.",
  rules: [{ kind: "command", program: "git", subcommands: [["commit"]] }],
  createdAt: "2026-11-12T10:00:00.000Z",
  updatedAt: "2026-11-12T10:00:00.000Z",
}

/** Same effect as COMMIT_GUARD, written as a permission rule with a resource glob. Only the evaluate hook can judge it. */
const GLOB_GUARD = {
  ...COMMIT_GUARD,
  id: "g-glob",
  label: "No commits (glob)",
  message: "Guard test: a glob rule blocked git commit.",
  rules: [{ kind: "permission", action: "shell", resources: ["git commit*"] }],
}

/** Same effect again, as a permission rule with no resources: it matches every shell command. */
const ALL_SHELL_GUARD = {
  ...COMMIT_GUARD,
  id: "g-all-shell",
  label: "No shell",
  message: "Guard test: all shell is blocked.",
  rules: [{ kind: "permission", action: "shell" }],
}

async function startRig(extraConfig: Record<string, unknown> = {}, probeFirst = true): Promise<GuardRig> {
  const sandbox = mkdtempSync(join(tmpdir(), "guard-ext-sandbox-"))
  const binDir = mkdtempSync(join(tmpdir(), "guard-ext-bin-"))
  const fakeGit = join(binDir, "git")
  writeFileSync(fakeGit, '#!/bin/sh\nprintf "x\\n" >> "$GUARD_MARKER_DIR/git-runs.log"\n')
  chmodSync(fakeGit, 0o755)
  scenario.dir = sandbox
  const probeFile = join(sandbox, "probe-evaluations.jsonl")
  const mock = startMockModel({ handler: (request) => respond(request) })
  const entry = pluginEntry()
  const provider = {
    package: join(repoRoot(), "test", "fixtures", "mock-provider"),
    options: { baseURL: mock.url, providerID: MODEL.providerID, modelID: MODEL.id },
  }
  const probe = { package: join(repoRoot(), "test", "fixtures", "guards-probe"), options: { logFile: probeFile, denyToken: "NEVER-MATCHES-THIS-TOKEN" } }
  const server = await startIsolatedServer({
    config: {
      plugins: probeFirst ? [provider, probe, entry] : [provider, entry, probe],
      ...extraConfig,
    },
    env: { PATH: `${binDir}:${process.env.PATH ?? "/usr/bin:/bin"}`, GUARD_MARKER_DIR: sandbox },
  })
  await waitFor(
    async () => {
      const response = await server.api<{ data: { providerID: string; id: string }[] }>("GET", "/api/model")
      return response.json.data.some((m) => m.providerID === MODEL.providerID && m.id === MODEL.id) ? true : undefined
    },
    60_000,
    "fake model",
  )
  await new Promise((resolve) => setTimeout(resolve, 2000))
  const feed = await server.subscribe()
  return {
    server,
    feed,
    mock,
    sandbox,
    binDir,
    probeFile,
    guardsDir: join(server.dirs.home, ".openchamber-guard-extension", "guards"),
    async stop() {
      feed.close()
      await server.stop()
      mock.stop()
      rmSync(sandbox, { recursive: true, force: true })
      rmSync(binDir, { recursive: true, force: true })
    },
  }
}

describe("guards: real plugin on an isolated server", () => {
  let rig: GuardRig
  let revision = 0
  const gitRuns = () => (existsSync(join(rig.sandbox, "git-runs.log")) ? readFileSync(join(rig.sandbox, "git-runs.log"), "utf8").split("\n").filter(Boolean).length : 0)
  const facts = () =>
    existsSync(join(rig.guardsDir, "lifecycle.jsonl"))
      ? readFileSync(join(rig.guardsDir, "lifecycle.jsonl"), "utf8").split("\n").map(parseLifecycleLine).filter((fact) => fact !== undefined)
      : []

  /** Writes the store as the extension service does: atomically, with a new revision. */
  function writeStore(activations: unknown[], guards: unknown[] = [COMMIT_GUARD]) {
    revision++
    mkdirSync(rig.guardsDir, { recursive: true })
    const temporary = join(rig.guardsDir, `.store-${revision}.tmp`)
    writeFileSync(temporary, JSON.stringify({ schema: "openchamber-guards/1", revision, guards, activations }))
    renameSync(temporary, join(rig.guardsDir, "store.json"))
  }
  const activation = (id: string, sessionId: string, extra: Partial<Activation> & { guardId?: string } = {}): Activation => ({
    id,
    guardId: COMMIT_GUARD.id,
    sessionId,
    scope: "session",
    createdAt: new Date().toISOString(),
    expiresAt: null,
    ...extra,
  })
  async function newSession(): Promise<string> {
    const created = await rig.server.api<{ data: { id: string } }>("POST", "/api/session", { location: { directory: rig.sandbox }, model: MODEL })
    expect(created.status).toBe(200)
    return created.json.data.id
  }
  async function prompt(sessionID: string, text: string) {
    // A connection that idled during a long wait can be closed by the server. The request was then not sent: retry once.
    const send = async () => {
      try {
        return await rig.server.api("POST", `/api/session/${sessionID}/prompt`, { text })
      } catch {
        return await rig.server.api("POST", `/api/session/${sessionID}/prompt`, { text })
      }
    }
    const sent = await send()
    expect(sent.status).toBe(200)
    await rig.server.api("POST", `/api/experimental/session/${sessionID}/wait`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const messages = await rig.server.api<any>("GET", `/api/session/${sessionID}/message`)
    return JSON.stringify(messages.json)
  }

  beforeAll(async () => {
    rig = await startRig()
  }, 150_000)
  afterAll(async () => {
    await rig?.stop()
  })

  test("without a guard the fake git runs; the plugin reports itself registered", async () => {
    const before = gitRuns()
    const sessionID = await newSession()
    const messages = await prompt(sessionID, "GSCN_ONE commit")
    expect(messages).toContain("GSCN ONE DONE")
    expect(gitRuns()).toBe(before + 1)
    const runtimeDir = join(rig.guardsDir, "runtime")
    await waitFor(async () => (existsSync(runtimeDir) && readdirSync(runtimeDir).some((f) => f.endsWith(".json")) ? true : undefined), 20_000, "runtime report")
    const reports = readdirSync(runtimeDir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => parseRuntimeReport(JSON.parse(readFileSync(join(runtimeDir, f), "utf8"))))
    expect(reports.every((r) => r.ok)).toBe(true)
    const ok = reports.flatMap((r) => (r.ok ? [r.value] : []))
    expect(ok.some((r) => r.registered && r.coveredActions.includes("shell") && r.storeState === "missing")).toBe(true)
    for (const f of readdirSync(runtimeDir)) expect(statSync(join(runtimeDir, f)).mode & 0o077).toBe(0)
  }, 120_000)

  test("root: a guarded command is denied before it runs, quoted text and other work proceed, no prompt", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-root", sessionID)])
    const before = gitRuns()
    const probeBefore = readJsonl(rig.probeFile).length
    const messages = await prompt(sessionID, "GSCN_ROOT run the commands")
    expect(gitRuns()).toBe(before) // The fake git never ran.
    expect(messages).toContain(COMMIT_GUARD.message)
    expect(messages).toContain("GSCN ROOT DONE")
    expect(existsSync(join(rig.sandbox, "echo-quoted.marker"))).toBe(true) // echo 'git commit' is only text.
    expect(existsSync(join(rig.sandbox, "allowed-g-root.marker"))).toBe(true)
    expect(rig.feed.events.filter((e) => e.type === "permission.asked" && e.data?.sessionID === sessionID)).toHaveLength(0)
    const evaluations = readJsonl(rig.probeFile).slice(probeBefore).filter((e) => e.kind === "evaluate" && e.sessionID === sessionID)
    report.guardsRoot = { incoming: evaluations.map((e) => ({ action: e.action, incomingEffect: e.incomingEffect })) }
    // The guarded command was blocked before any permission hook ran, so the earlier probe never saw it.
    const shellResources = evaluations.filter((e) => e.action === "shell").flatMap((e) => e.resources as string[])
    expect(shellResources.some((r) => r.startsWith("git commit"))).toBe(false)
    expect(shellResources.some((r) => r.includes("allowed-g-root.marker"))).toBe(true) // Unguarded shell reaches it.
    expect(shellResources.some((r) => r.includes("echo-quoted.marker"))).toBe(true)
    const provider = readJsonl(requestLog)
    expect(provider.some((r) => r.messages.some((m: any) => m.role === "tool" && String(m.content).includes(COMMIT_GUARD.message)))).toBe(true)
  }, 120_000)

  test("subagent: the child session inherits the guard from its root", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-parent", sessionID)])
    const before = gitRuns()
    const messages = await prompt(sessionID, "GSCN_PARENT delegate")
    expect(messages).toContain("GSCN PARENT DONE")
    expect(gitRuns()).toBe(before)
    expect(existsSync(join(rig.sandbox, "allowed-g-child.marker"))).toBe(true)
    const children = [...new Set(readJsonl(rig.probeFile).filter((e) => e.parentID === sessionID).map((e) => e.sessionID))]
    expect(children.length).toBe(1)
    const child = await rig.server.api<any>("GET", `/api/session/${children[0]}/message`)
    expect(JSON.stringify(child.json)).toContain(COMMIT_GUARD.message)
  }, 120_000)

  test("an unguarded session is unaffected; deleting the activation stops the guard", async () => {
    const guarded = await newSession()
    const free = await newSession()
    writeStore([activation("act-g", guarded)])
    const before = gitRuns()
    await prompt(guarded, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before)
    await prompt(free, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1)
    writeStore([])
    await prompt(guarded, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 2)
  }, 120_000)

  test("explicit expiry is honored at the next action; no expiry means the guard stays", async () => {
    const timed = await newSession()
    const forever = await newSession()
    writeStore([
      activation("act-timed", timed, { expiresAt: new Date(Date.now() + 6_000).toISOString() }),
      activation("act-forever", forever),
    ])
    const before = gitRuns()
    await prompt(timed, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before) // Before expiry: denied.
    await new Promise((resolve) => setTimeout(resolve, 6_000)) // The explicit expiry passes. No timer fires in the plugin.
    await prompt(timed, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1) // After expiry: allowed.
    await prompt(forever, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1) // No expiry: still denied.
  }, 120_000)

  test("request scope: bound on the next run, released after the root and its subagent end", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-request", sessionID, { scope: "request" })])
    const before = gitRuns()
    const messages = await prompt(sessionID, "GSCN_PARENT delegate")
    expect(messages).toContain("GSCN PARENT DONE")
    expect(gitRuns()).toBe(before)
    await waitFor(async () => (facts().some((f) => f.activationId === "act-request" && f.fact === "ended") ? true : undefined), 20_000, "ended fact")
    const mine = facts().filter((f) => f.activationId === "act-request")
    report.requestFacts = mine
    const bound = mine.find((f) => f.fact === "bound")
    const ended = mine.find((f) => f.fact === "ended")
    expect(bound?.reason).toBe("observed-start")
    expect(ended?.reason).toBe("request-completed")
    expect(mine.some((f) => f.fact === "uncertain")).toBe(false)
    expect(Date.parse(bound!.at)).toBeLessThanOrEqual(Date.parse(ended!.at))
    // The store still lists the activation (only the service deletes it). The backend has released it.
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1)
  }, 120_000)

  test("request scope with a built-in subagent: child denied, root and child end, persisted end, next request runs", async () => {
    const sessionID = await newSession()
    const requestActivation = activation("act-conj", sessionID, { scope: "request" })
    writeStore([requestActivation])
    const storeFile = join(rig.guardsDir, "store.json")
    const storeBefore = readFileSync(storeFile, "utf8")
    rmSync(join(rig.sandbox, "allowed-g-child.marker"), { force: true })
    const before = gitRuns()
    const probeBefore = readJsonl(rig.probeFile).length
    const askedBefore = rig.feed.events.filter((e) => e.type === "permission.asked").length

    // Request 1: the root delegates to a built-in subagent whose first command is guarded.
    const messages = await prompt(sessionID, "GSCN_PARENT delegate")
    expect(messages).toContain("GSCN PARENT DONE") // The agent continued.
    expect(gitRuns()).toBe(before) // Neither session ran the fake git.
    const evaluations = readJsonl(rig.probeFile).slice(probeBefore)
    const childID = [...new Set(evaluations.filter((e) => e.parentID === sessionID).map((e) => e.sessionID))][0] as string
    expect(childID).toBeDefined()
    const child = JSON.stringify((await rig.server.api<any>("GET", `/api/session/${childID}/message`)).json)
    expect(child).toContain(COMMIT_GUARD.message) // The child was denied directly.
    expect(child).toContain("GSCN CHILD DONE")
    expect(existsSync(join(rig.sandbox, "allowed-g-child.marker"))).toBe(true)
    expect(rig.feed.events.filter((e) => e.type === "permission.asked")).toHaveLength(askedBefore) // No prompts.

    // The persisted log proves one clean sequence, and the end is later than the end of BOTH sessions.
    await waitFor(async () => (facts().some((f) => f.activationId === "act-conj" && f.fact === "ended") ? true : undefined), 20_000, "ended fact")
    const mine = facts().filter((f) => f.activationId === "act-conj")
    expect(mine.map((f) => f.fact).filter((fact, index, all) => all.indexOf(fact) === index)).toEqual(["bound", "ended"])
    // Each plugin instance of the server may bind. The instance that ended must have bound before it ended.
    const ended = mine.find((f) => f.fact === "ended")!
    const bound = mine.find((f) => f.fact === "bound" && f.instance === ended.instance)
    expect(bound).toBeDefined()
    expect(mine.indexOf(bound!)).toBeLessThan(mine.indexOf(ended))
    expect(ended.reason).toBe("request-completed")
    expect(mine.some((f) => f.fact === "uncertain")).toBe(false)
    const lifecycleText = readFileSync(join(rig.guardsDir, "lifecycle.jsonl"), "utf8")
    const view = resolveLifecycleViews([requestActivation], parseLifecycleText(lifecycleText, false))[0]!
    expect(view).toMatchObject({ phase: "ended", releasable: true, trust: "ok" })
    const terminal = rig.feed.events.filter(
      (e) => /^session\.execution\.(succeeded|failed|interrupted)$/.test(e.type) && (e.data?.sessionID === sessionID || e.data?.sessionID === childID),
    )
    expect(new Set(terminal.map((e) => e.data.sessionID))).toEqual(new Set([sessionID, childID]))
    for (const event of terminal) expect(Date.parse(ended.at)).toBeGreaterThanOrEqual(Number(event.raw?.created))

    // Request 2, in the same session: allowed. Neither the service nor the UI changed the store.
    expect(readFileSync(storeFile, "utf8")).toBe(storeBefore)
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1)
    expect(rig.feed.events.filter((e) => e.type === "permission.asked")).toHaveLength(askedBefore)
  }, 150_000)

  test("request scope: a user interruption ends the request", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-interrupt", sessionID, { scope: "request" })])
    await rig.server.api("POST", `/api/session/${sessionID}/prompt`, { text: "SCENARIO_HANG" })
    await waitFor(async () => (facts().some((f) => f.activationId === "act-interrupt" && f.fact === "bound") ? true : undefined), 30_000, "bound fact")
    await rig.server.api("POST", `/api/session/${sessionID}/interrupt`)
    await waitFor(async () => (facts().some((f) => f.activationId === "act-interrupt" && f.fact === "ended") ? true : undefined), 30_000, "ended fact")
    expect(facts().some((f) => f.activationId === "act-interrupt" && f.fact === "uncertain")).toBe(false)
  }, 120_000)

  test("deleting store.json while a guard is active keeps it; a valid store without the activation releases it", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-delete", sessionID)])
    const before = gitRuns()
    await prompt(sessionID, "GSCN_ONE commit") // The plugin reads the good store here.
    expect(gitRuns()).toBe(before)
    rmSync(join(rig.guardsDir, "store.json"))
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before) // The file is gone; the last good guard still applies.
    writeStore([]) // The service releases by writing a valid store.
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before + 1)
  }, 120_000)

  test("a request end that another instance persisted releases the guard with no service call", async () => {
    const sessionID = await newSession()
    const created = new Date().toISOString()
    writeStore([activation("act-dead", sessionID, { scope: "request", createdAt: created })])
    const guarded = gitRuns()
    await prompt(sessionID, "GSCN_ONE commit") // Binds the request in the backend (the root starts after creation).
    expect(gitRuns()).toBe(guarded)
    // A dead instance wrote the end of ANOTHER request; the live instances never saw its events.
    const other = await newSession()
    const createdOther = new Date().toISOString()
    writeStore([activation("act-dead-2", other, { scope: "request", createdAt: createdOther })])
    const at = Date.parse(createdOther) + 1
    const fact = (kind: string, ms: number, reason: string) =>
      `\n${JSON.stringify({ activationId: "act-dead-2", fact: kind, at: new Date(ms).toISOString(), reason, instance: "dead-instance" })}\n`
    writeFileSync(join(rig.guardsDir, "lifecycle.jsonl"), `${fact("bound", at, "observed-start")}{"activationId":"act-dead-2","fa${fact("ended", at + 1, "request-completed")}`, { flag: "a" })
    const baseline = gitRuns()
    await prompt(other, "GSCN_ONE commit")
    expect(gitRuns()).toBe(baseline + 1) // The persisted clean end releases it, despite the crashed fragment.
  }, 120_000)

  test("a new location with an invalid store fails closed, stays closed while the file is missing, and opens on a valid store", async () => {
    const location = mkdtempSync(join(tmpdir(), "guard-ext-loc-"))
    try {
      const created = await rig.server.api<{ data: { id: string } }>("POST", "/api/session", { location: { directory: location }, model: MODEL })
      expect(created.status).toBe(200)
      const sessionID = created.json.data.id
      mkdirSync(rig.guardsDir, { recursive: true })
      writeFileSync(join(rig.guardsDir, "store.json"), "{ not a store")
      const before = gitRuns()
      const closed = await prompt(sessionID, "GSCN_ONE commit")
      report.recoveryClosed = closed.slice(0, 600)
      expect(gitRuns()).toBe(before)
      expect(closed).toContain("could not be loaded")
      rmSync(join(rig.guardsDir, "store.json"))
      await prompt(sessionID, "GSCN_ONE commit")
      expect(gitRuns()).toBe(before) // A repair can show a missing file. Still closed.
      writeStore([])
      await prompt(sessionID, "GSCN_ONE commit")
      expect(gitRuns()).toBe(before + 1) // A valid empty store opens it.
    } finally {
      rmSync(location, { recursive: true, force: true })
    }
  }, 150_000)

  test("an invalid store file after a good read keeps the last good store", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-lastgood", sessionID)])
    const before = gitRuns()
    await prompt(sessionID, "GSCN_ONE commit") // The plugin reads the good store here.
    expect(gitRuns()).toBe(before)
    writeFileSync(join(rig.guardsDir, "store.json"), "{ torn write")
    await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before) // The last good store still applies.
  }, 120_000)

  const probeShell = (sessionID: string, since: number) =>
    readJsonl(rig.probeFile).slice(since).filter((e) => e.kind === "evaluate" && e.sessionID === sessionID && e.action === "shell")

  test("early gate: a command-rule denial never reaches an earlier permission hook and never runs; unguarded shell does reach it", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-early", sessionID)])
    rmSync(join(rig.sandbox, "unguarded-probe.marker"), { force: true })
    const before = gitRuns()
    const since = readJsonl(rig.probeFile).length
    const askedBefore = rig.feed.events.filter((e) => e.type === "permission.asked").length
    const guarded = await prompt(sessionID, "GSCN_ONE commit")
    expect(gitRuns()).toBe(before)
    expect(guarded).toContain(COMMIT_GUARD.message) // The model reads the guard message as the tool error.
    expect(guarded).toContain("GSCN ONE DONE") // The agent continued.
    expect(probeShell(sessionID, since)).toHaveLength(0) // The probe loads first and never saw the command.
    const unguarded = await prompt(sessionID, "GSCN_UNGUARDED run")
    expect(unguarded).toContain("GSCN UNGUARDED DONE")
    expect(existsSync(join(rig.sandbox, "unguarded-probe.marker"))).toBe(true)
    const seen = probeShell(sessionID, since)
    expect(seen).toHaveLength(1)
    expect(seen[0].resources.some((r: string) => r.includes("unguarded-probe.marker"))).toBe(true)
    expect(seen[0].incomingEffect).toBe("allow")
    expect(rig.feed.events.filter((e) => e.type === "permission.asked")).toHaveLength(askedBefore)
    report.earlyGate = { guardedProbeEvaluations: 0, unguardedProbeEvaluations: seen.length }
  }, 120_000)

  test("early gate: a guarded command inside a compound command never reaches an earlier permission hook and never runs", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-compound", sessionID)])
    rmSync(join(rig.sandbox, "unguarded-probe.marker"), { force: true })
    const before = gitRuns()
    const since = readJsonl(rig.probeFile).length
    const messages = await prompt(sessionID, "GSCN_COMPOUND run")
    expect(gitRuns()).toBe(before)
    expect(messages).toContain(COMMIT_GUARD.message)
    expect(messages).toContain("GSCN COMPOUND DONE")
    expect(probeShell(sessionID, since)).toHaveLength(0)
  }, 120_000)

  test("early gate: a permission rule for shell with no resources blocks before an earlier permission hook", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-allshell", sessionID, { guardId: ALL_SHELL_GUARD.id })], [ALL_SHELL_GUARD])
    rmSync(join(rig.sandbox, "unguarded-probe.marker"), { force: true })
    const since = readJsonl(rig.probeFile).length
    const messages = await prompt(sessionID, "GSCN_UNGUARDED run")
    expect(existsSync(join(rig.sandbox, "unguarded-probe.marker"))).toBe(false) // The command never ran.
    expect(messages).toContain(ALL_SHELL_GUARD.message)
    expect(probeShell(sessionID, since)).toHaveLength(0)
  }, 120_000)

  test("limit: a permission rule with resource globs is enforced by the evaluate hook, but an earlier permission hook sees the command first", async () => {
    const sessionID = await newSession()
    writeStore([activation("act-glob", sessionID, { guardId: GLOB_GUARD.id })], [GLOB_GUARD])
    const before = gitRuns()
    const since = readJsonl(rig.probeFile).length
    const messages = await prompt(sessionID, "GSCN_COMPOUND run")
    // Still enforced: the segment `git commit -m guarded` matches the glob, the effect becomes deny, and nothing runs.
    expect(gitRuns()).toBe(before)
    expect(messages).toContain(GLOB_GUARD.message)
    expect(messages).toContain("GSCN COMPOUND DONE")
    // Not covered early: the earlier probe received the command. A plugin that sends commands upstream in its own
    // evaluate hook would have sent it. The probe records the segments that OpenCode passed.
    const seen = probeShell(sessionID, since)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.flatMap((e) => e.resources as string[])).toEqual(expect.arrayContaining(["echo safe", "git commit -m guarded"]))
    report.globLimit = { probeSawCommand: true, resources: seen.map((e) => e.resources) }
  }, 120_000)
})

describe("guards: ordinary approval that would prompt", () => {
  let rig: GuardRig
  beforeAll(async () => {
    const rule = [{ action: "shell", resource: "*", effect: "ask" }]
    // The probe loads first, so it records the effect that ordinary permissions produce before the guard hook runs.
    rig = await startRig({ permissions: rule }, true)
  }, 150_000)
  afterAll(async () => {
    await rig?.stop()
  })

  const writeStore = (sessionIDs: string[]) => {
    mkdirSync(rig.guardsDir, { recursive: true })
    writeFileSync(
      join(rig.guardsDir, "store.json"),
      JSON.stringify({
        schema: "openchamber-guards/1",
        revision: 1,
        guards: [COMMIT_GUARD],
        activations: sessionIDs.map((sessionId, index) => ({ id: `act-ask-${index}`, guardId: COMMIT_GUARD.id, sessionId, scope: "session", createdAt: new Date().toISOString(), expiresAt: null })),
      }),
    )
  }
  const newSession = async () => {
    const created = await rig.server.api<{ data: { id: string } }>("POST", "/api/session", { location: { directory: rig.sandbox }, model: MODEL })
    return created.json.data.id
  }
  const shellEvaluations = (sessionID: string) => readJsonl(rig.probeFile).filter((e) => e.kind === "evaluate" && e.sessionID === sessionID && e.action === "shell")

  test("a guarded command is denied before an earlier permission hook and without a prompt, and the agent continues", async () => {
    const sessionID = await newSession()
    writeStore([sessionID])
    await rig.server.api("POST", `/api/session/${sessionID}/prompt`, { text: "GSCN_ONE commit" })
    await rig.server.api("POST", `/api/experimental/session/${sessionID}/wait`)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    const messages = JSON.stringify((await rig.server.api<any>("GET", `/api/session/${sessionID}/message`)).json)
    expect(messages).toContain(COMMIT_GUARD.message)
    expect(messages).toContain("GSCN ONE DONE")
    expect(existsSync(join(rig.sandbox, "git-runs.log"))).toBe(false) // The fake git never ran.
    expect(rig.feed.events.filter((e) => e.type === "permission.asked" && e.data?.sessionID === sessionID)).toHaveLength(0)
    // The probe loads first. It would have seen `ask` here before the early gate existed. It sees nothing now.
    expect(shellEvaluations(sessionID)).toHaveLength(0)
    const pending = await rig.server.api<any>("GET", "/api/permission")
    if (pending.status === 200 && pending.json !== undefined) expect(JSON.stringify(pending.json)).not.toContain("git commit")
  }, 120_000)

  test("an unguarded session's shell command reaches the earlier permission hook, with the ordinary effect `ask`", async () => {
    const guarded = await newSession()
    const free = await newSession()
    writeStore([guarded])
    await rig.server.api("POST", `/api/session/${free}/prompt`, { text: "GSCN_UNGUARDED run" })
    const asked = await rig.feed.waitFor((e) => e.type === "permission.asked" && e.data?.sessionID === free, 60_000, "permission prompt for the unguarded session")
    expect(asked).toBeDefined()
    const seen = shellEvaluations(free)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(seen.every((e) => e.incomingEffect === "ask")).toBe(true)
    expect(existsSync(join(rig.sandbox, "unguarded-probe.marker"))).toBe(false) // Waiting for approval: not run yet.
    await rig.server.api("POST", `/api/session/${free}/interrupt`)
  }, 120_000)
})
