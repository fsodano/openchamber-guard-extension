/**
 * The early shell gate: `ctx.tool.hook("execute.before")`.
 *
 * OpenCode runs it before every permission hook. A plugin that loads earlier and acts in `permission.evaluate` cannot
 * see a shell command that the gate blocks, whatever the load order is. The gate blocks by throwing an error.
 *
 * The gate judges the whole command text, so it blocks only: command rules, permission rules for `shell` with no
 * resources, and every shell call when the store is unusable or its own check fails. A permission rule with resource
 * globs matches the segments that OpenCode splits out of the command, which a tool hook cannot read. The gate leaves
 * such a command to the `evaluate` hook. It is still denied there, but an earlier permission hook can see it first.
 * The tests below state both sides.
 */

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import { setupGuards } from "../../../src/guards/index.ts"
import { createPlugin } from "../../../src/index.ts"
import { FAIL_CLOSED_MESSAGE, parseRuntimeReport, type GuardStore, type Rule } from "../../../src/guards/schema.ts"
import { runtimeFileName } from "../../../src/guards/store.ts"
import { createMemoryLogger } from "../../../src/log.ts"
import { activation, commitRule, createGuardCtx, createMemoryFs, guard, PATHS, settle, storeOf } from "./helpers.ts"

const BASE = Date.parse("2026-11-12T10:00:00.000Z")
const MESSAGE = "Commits are blocked by your guard."
const REPORT_FILE = join(PATHS.runtimeDir, runtimeFileName("/fake/project"))

interface StartInput {
  store?: GuardStore | string
  sessions?: Record<string, string | null>
  failToolHook?: boolean
  failHook?: boolean
  failDispose?: boolean
  now?: () => number
  fsSetup?: (fs: ReturnType<typeof createMemoryFs>) => void
}

async function start(input: StartInput = {}) {
  const fs = createMemoryFs()
  if (input.store !== undefined) fs.put(PATHS.store, typeof input.store === "string" ? input.store : JSON.stringify(input.store))
  input.fsSetup?.(fs)
  const g = createGuardCtx({
    sessions: input.sessions ?? { root: null, child: "root", grandchild: "child", other: null },
    failToolHook: input.failToolHook,
    failHook: input.failHook,
    failDispose: input.failDispose,
    directory: "/fake/project",
  })
  const log = createMemoryLogger()
  const cleanup = await setupGuards(g.ctx, log, {
    fs,
    home: () => "/fake/home",
    now: () => new Date(input.now ? input.now() : BASE),
    instanceId: "inst-test",
    setInterval: () => 1,
    clearInterval: () => {},
    sleep: async () => {},
  })
  const report = () => {
    const parsed = parseRuntimeReport(JSON.parse(fs.files.get(REPORT_FILE)!))
    if (!parsed.ok) throw new Error("report did not parse")
    return parsed.value
  }
  return { fs, g, log, cleanup, report }
}

const shell = (sessionID: string, command: string) => ({ sessionID, tool: "shell", input: { command } })
const evaluate = (sessionID: string, resources: string[]) => ({ sessionID, action: "shell", resources, effect: "allow" })
const commitStore = storeOf([guard("g1", [commitRule], MESSAGE)], [activation("a1", "g1", "root")])

describe("early shell gate: enforcement", () => {
  test("blocks a shell command that a command rule guards, with the guard message, before any permission hook", async () => {
    const t = await start({ store: commitStore })
    const result = await t.g.before(shell("root", "git commit -m x"))
    expect(result.blocked).toBe(true)
    expect(result.message).toBe(MESSAGE)
    // The gate only blocks. It does not rewrite the call.
    expect(result.event.tool).toBe("shell")
    expect(result.event.input).toEqual({ command: "git commit -m x" })
  })

  test("lets an unguarded command, quoted text, and an unguarded session through", async () => {
    const t = await start({ store: commitStore })
    expect((await t.g.before(shell("root", "git status"))).blocked).toBe(false)
    expect((await t.g.before(shell("root", "echo 'git commit'"))).blocked).toBe(false)
    expect((await t.g.before(shell("other", "git commit -m x"))).blocked).toBe(false)
  })

  test("children and grandchildren inherit; a session whose parent cannot be read is guarded", async () => {
    const t = await start({ store: commitStore, sessions: { root: null, child: "root", grandchild: "child", other: null } })
    expect((await t.g.before(shell("child", "git commit"))).blocked).toBe(true)
    expect((await t.g.before(shell("grandchild", "git commit"))).blocked).toBe(true)
    expect((await t.g.before(shell("mystery", "git commit"))).blocked).toBe(true)
    expect((await t.g.before(shell("mystery", "git status"))).blocked).toBe(false)
  })

  test("only the shell tool is gated early; other tools pass, and the evaluate hook still guards them", async () => {
    const rules: Rule[] = [
      { kind: "permission", action: "edit", resources: ["/repo/secrets/**"] },
      { kind: "permission", action: "subagent" },
      commitRule,
    ]
    const t = await start({ store: storeOf([guard("g2", rules, MESSAGE)], [activation("a2", "g2", "root")]) })
    for (const tool of ["edit", "write", "subagent", "read", "webfetch", "grep", "Shell", "bash"]) {
      expect((await t.g.before({ sessionID: "root", tool, input: { command: "git commit -m x", path: "/repo/secrets/a" } })).blocked).toBe(false)
    }
    expect((await t.g.evaluate({ sessionID: "root", action: "edit", resources: ["/repo/secrets/a"], effect: "allow" })).effect).toBe("deny")
    expect((await t.g.evaluate({ sessionID: "root", action: "subagent", resources: ["general"], effect: "allow" })).effect).toBe("deny")
  })

  test("a shell call with no command text is judged like an empty command", async () => {
    const t = await start({ store: commitStore })
    for (const input of [undefined, null, {}, { command: 5 }]) {
      expect((await t.g.before({ sessionID: "root", tool: "shell", input })).blocked).toBe(false)
    }
    const all = await start({ store: storeOf([guard("g3", [{ kind: "permission", action: "shell" }], MESSAGE)], [activation("a3", "g3", "root")]) })
    expect((await all.g.before({ sessionID: "root", tool: "shell", input: undefined })).blocked).toBe(true)
  })

  test("no store, an expired activation, and a deleted guard block nothing", async () => {
    expect((await (await start()).g.before(shell("root", "git commit"))).blocked).toBe(false)
    const expired = storeOf([guard("g1", [commitRule])], [activation("a1", "g1", "root", { expiresAt: new Date(BASE - 1).toISOString() })])
    expect((await (await start({ store: expired })).g.before(shell("root", "git commit"))).blocked).toBe(false)
    const t = await start({ store: commitStore })
    expect((await t.g.before(shell("root", "git commit"))).blocked).toBe(true)
    t.fs.put(PATHS.store, JSON.stringify(storeOf([], [], 2)))
    expect((await t.g.before(shell("root", "git commit"))).blocked).toBe(false)
  })

  test("the activation snapshot wins over a later guard edit, as in the evaluate hook", async () => {
    const snapshot = { label: "old", message: "old message", rules: [commitRule] }
    const edited = storeOf([guard("g1", [{ kind: "command", program: "rm" }], "new message")], [activation("a1", "g1", "root", { snapshot })])
    const t = await start({ store: edited })
    const result = await t.g.before(shell("root", "git commit"))
    expect(result.message).toBe("old message")
    expect((await t.g.before(shell("root", "rm -rf x"))).blocked).toBe(false)
  })

  test("the early gate never changes the persisted store", async () => {
    const t = await start({ store: commitStore })
    const before = t.fs.files.get(PATHS.store)
    await t.g.before(shell("root", "git commit"))
    expect(t.fs.files.get(PATHS.store)).toBe(before)
    expect(JSON.parse(before!).activations[0]).not.toHaveProperty("snapshot")
  })
})

describe("early shell gate: rule types", () => {
  test("a permission rule for shell with no resources blocks every shell command early", async () => {
    const t = await start({ store: storeOf([guard("g1", [{ kind: "permission", action: "shell" }], MESSAGE)], [activation("a1", "g1", "root")]) })
    expect((await t.g.before(shell("root", "ls"))).message).toBe(MESSAGE)
    expect((await t.g.before(shell("other", "ls"))).blocked).toBe(false)
  })

  test("a permission rule with resource globs stays with the evaluate hook, which still denies", async () => {
    const t = await start({ store: storeOf([guard("g1", [{ kind: "permission", action: "shell", resources: ["rm *"] }], MESSAGE)], [activation("a1", "g1", "root")]) })
    // The glob targets the resources of the permission request, not the whole command text.
    expect((await t.g.before(shell("root", "rm x"))).blocked).toBe(false)
    const denied = await t.g.evaluate(evaluate("root", ["rm x"]))
    expect(denied.effect).toBe("deny")
    expect(denied.message).toBe(MESSAGE)
  })

  test("a resource-glob rule on a compound command: not judged early, still denied by evaluate on the segments", async () => {
    // OpenCode 2.2.5 passes `echo safe` and `git commit -m x` as the resources of `echo safe && git commit -m x`.
    const t = await start({ store: storeOf([guard("g1", [{ kind: "permission", action: "shell", resources: ["git commit*"] }], MESSAGE)], [activation("a1", "g1", "root")]) })
    expect((await t.g.before(shell("root", "echo safe && git commit -m x"))).blocked).toBe(false) // A hook before evaluate can see it.
    expect((await t.g.before(shell("root", "git commit -m x"))).blocked).toBe(false)
    const denied = await t.g.evaluate(evaluate("root", ["echo safe", "git commit -m x"]))
    expect(denied.effect).toBe("deny")
    expect(denied.message).toBe(MESSAGE)
    expect((await t.g.evaluate(evaluate("root", ["echo safe"]))).effect).toBe("allow")
  })

  test("in a guard with mixed rules, the command rule blocks early and the glob rule does not", async () => {
    const rules: Rule[] = [{ kind: "permission", action: "shell", resources: ["npm publish*"] }, commitRule]
    const t = await start({ store: storeOf([guard("g1", rules, MESSAGE)], [activation("a1", "g1", "root")]) })
    expect((await t.g.before(shell("root", "git commit -m x"))).blocked).toBe(true)
    expect((await t.g.before(shell("root", "npm publish"))).blocked).toBe(false)
    expect((await t.g.evaluate(evaluate("root", ["npm publish"]))).effect).toBe("deny")
  })

  test("permission rules for other actions never block shell early", async () => {
    const t = await start({ store: storeOf([guard("g1", [{ kind: "permission", action: "edit" }], MESSAGE)], [activation("a1", "g1", "root")]) })
    expect((await t.g.before(shell("root", "ls"))).blocked).toBe(false)
  })

  test("the early view does not leak a rule from one activation into another", async () => {
    const store = storeOf(
      [guard("g1", [commitRule], "one"), guard("g2", [{ kind: "command", program: "rm" }], "two")],
      [activation("a1", "g1", "root"), activation("a2", "g2", "other")],
    )
    const t = await start({ store })
    expect((await t.g.before(shell("root", "git commit"))).message).toBe("one")
    expect((await t.g.before(shell("root", "rm x"))).blocked).toBe(false)
    expect((await t.g.before(shell("other", "rm x"))).message).toBe("two")
    expect((await t.g.before(shell("other", "git commit"))).blocked).toBe(false)
  })
})

describe("early shell gate: fail closed", () => {
  const invalid = '{"schema":"td-guards/1","revision":1,"guards":[{"bad":true}],"activations":[]}'

  test("an invalid store blocks every shell call with the fixed message, and not other tools", async () => {
    const t = await start({ store: invalid })
    const result = await t.g.before(shell("root", "ls"))
    expect(result.blocked).toBe(true)
    expect(result.message).toBe(FAIL_CLOSED_MESSAGE)
    expect((await t.g.before({ sessionID: "root", tool: "read", input: { path: "x" } })).blocked).toBe(false)
    // The service repairs the file: the gate opens again and the guard applies.
    t.fs.put(PATHS.store, JSON.stringify(commitStore))
    expect((await t.g.before(shell("root", "ls"))).blocked).toBe(false)
    expect((await t.g.before(shell("root", "git commit"))).message).toBe(MESSAGE)
  })

  test("a store that cannot be read at startup blocks shell", async () => {
    const t = await start({ store: commitStore, fsSetup: (fs) => (fs.failures.read = true) })
    expect((await t.g.before(shell("root", "ls"))).message).toBe(FAIL_CLOSED_MESSAGE)
  })

  test("an invalid store after a good one keeps the last good store", async () => {
    const t = await start({ store: commitStore })
    t.fs.put(PATHS.store, "{ torn write")
    expect((await t.g.before(shell("root", "git commit"))).message).toBe(MESSAGE)
    expect((await t.g.before(shell("root", "ls"))).blocked).toBe(false)
  })

  test("an internal failure while deciding blocks with the fixed message", async () => {
    let broken = false
    const t = await start({
      store: commitStore,
      now: () => {
        if (broken) throw new Error("clock failure")
        return BASE
      },
    })
    broken = true
    const result = await t.g.before(shell("root", "ls"))
    expect(result.blocked).toBe(true)
    expect(result.message).toBe(FAIL_CLOSED_MESSAGE)
    expect((await t.g.before({ sessionID: "root", tool: "read", input: {} })).blocked).toBe(false)
  })
})

describe("early shell gate: command-rule parity with the evaluate hook", () => {
  const rules: Rule[] = [commitRule, { kind: "command", program: "git", subcommands: [["push"]], flags: ["--force"] }, { kind: "command", program: "terraform", subcommands: [["destroy"]] }]
  const store = storeOf([guard("g1", rules, MESSAGE)], [activation("a1", "g1", "root")])

  // `evaluate` receives the pieces that OpenCode splits out of the command. The pieces here follow that form.
  const guarded: Array<[string, string[]]> = [
    ["git commit -m x", ["git commit -m x"]],
    ["/usr/bin/git -C /tmp/r commit -m x", ["/usr/bin/git -C /tmp/r commit -m x"]],
    ["git add . && git commit -m x", ["git add .", "git commit -m x"]],
    ["git add .; git commit -m x", ["git add .", "git commit -m x"]],
    ["false || git commit", ["false", "git commit"]],
    ["echo hi | git commit", ["echo hi", "git commit"]],
    ["FOO=bar git commit", ["FOO=bar git commit"]],
    ["env -i FOO=1 git commit", ["env -i FOO=1 git commit"]],
    ["sudo -u root git commit", ["sudo -u root git commit"]],
    ["timeout 5 git commit", ["timeout 5 git commit"]],
    ["nohup git commit", ["nohup git commit"]],
    ["bash -c 'git commit -m x'", ["bash -c 'git commit -m x'"]],
    ['sh -c "git commit"', ['sh -c "git commit"']],
    ["eval 'git commit'", ["eval 'git commit'"]],
    ["echo $(git commit)", ["echo $(git commit)"]],
    ["echo `git commit`", ["echo `git commit`"]],
    ['echo "$(git commit)"', ['echo "$(git commit)"']],
    ["find . -exec git commit {} \\;", ["find . -exec git commit {} \\;"]],
    ['g"i"t commit', ['g"i"t commit']],
    ["\\git commit", ["\\git commit"]],
    ["git commit > /dev/null 2>&1", ["git commit"]],
    ["git commit 2>&1 | tee out.log", ["git commit", "tee out.log"]],
    ["2>&1 git commit", ["git commit"]],
    ["ls\ngit commit", ["ls", "git commit"]],
    ["(git commit)", ["git commit"]],
    ["{ git commit; }", ["git commit"]],
    ["if true; then git commit; fi", ["git commit"]],
    ["git push origin main --force", ["git push origin main --force"]],
    ["cd x && git push --force > /dev/null", ["cd x", "git push --force"]],
    ["sudo git push --force", ["sudo git push --force"]],
    ["terraform destroy -auto-approve", ["terraform destroy -auto-approve"]],
  ]
  const unguarded: Array<[string, string[]]> = [
    ["git status", ["git status"]],
    ["git add . && git push", ["git add .", "git push"]],
    ["echo 'git commit'", ["echo 'git commit'"]],
    ['echo "git commit"', ['echo "git commit"']],
    ["echo git commit", ["echo git commit"]],
    ["grep 'git commit' log.txt", ["grep 'git commit' log.txt"]],
    ["cat commit.txt > git-commit.log", ["cat commit.txt"]],
    ["printf x > /tmp/git/commit", ["printf x"]],
    ["git push origin main", ["git push origin main"]],
    ["git pull --force", ["git pull --force"]],
    ["terraform plan", ["terraform plan"]],
    ["ls | wc -l", ["ls", "wc -l"]],
    ["", [""]],
  ]

  test("every representative command-rule match is blocked by both hooks", async () => {
    const t = await start({ store })
    for (const [command, resources] of guarded) {
      const early = await t.g.before(shell("root", command))
      const late = await t.g.evaluate(evaluate("root", resources))
      expect([command, early.blocked]).toEqual([command, true])
      expect([command, late.effect]).toEqual([command, "deny"])
      expect(early.message).toBe(MESSAGE)
      expect(late.message).toBe(MESSAGE)
    }
  })

  test("the early gate also sees what split resources can omit, such as a heredoc body", async () => {
    const t = await start({ store })
    const command = "cat <<EOF | sh\ngit commit\nEOF"
    expect((await t.g.before(shell("root", command))).blocked).toBe(true)
    expect((await t.g.evaluate(evaluate("root", ["cat", "sh"]))).effect).toBe("allow") // Resources alone miss it.
  })

  test("every representative command that the rules do not match passes both hooks", async () => {
    const t = await start({ store })
    for (const [command, resources] of unguarded) {
      const early = await t.g.before(shell("root", command))
      const late = await t.g.evaluate(evaluate("root", resources))
      expect([command, early.blocked]).toEqual([command, false])
      expect([command, late.effect]).toEqual([command, "allow"])
    }
  })

  test("the whole command as the only resource gives the same answer as the early gate", async () => {
    const t = await start({ store })
    for (const [command] of [...guarded, ...unguarded]) {
      const early = await t.g.before(shell("root", command))
      const late = await t.g.evaluate(evaluate("root", [command]))
      expect([command, early.blocked]).toEqual([command, late.effect === "deny"])
    }
  })
})

describe("early shell gate: report, log, and counts", () => {
  test("an early block counts once and the report and log never hold the command", async () => {
    const t = await start({ store: commitStore })
    expect(t.report().blockedCount).toBe(0)
    await t.g.before(shell("child", "git commit -m SECRET-COMMAND-TEXT"))
    await settle()
    expect(t.report()).toMatchObject({ registered: true, blockedCount: 1, uncertainCount: 0, coveredActions: ["shell", "subagent"] })
    const text = t.fs.files.get(REPORT_FILE)!
    expect(text).not.toContain("SECRET-COMMAND-TEXT")
    expect(text).not.toContain("git commit")
    expect(t.log.lines.join("\n")).not.toContain("SECRET-COMMAND-TEXT")
    expect(t.fs.appended.join("")).not.toContain("SECRET-COMMAND-TEXT")
  })

  test("a call that the early gate blocks never reaches evaluate, and a call that it passes and evaluate denies counts once", async () => {
    const t = await start({ store: commitStore })
    const early = await t.g.before(shell("root", "git commit"))
    expect(early.blocked).toBe(true)
    await settle()
    expect(t.report().blockedCount).toBe(1)
    // A resource-glob rule is not judged early. Only the evaluate hook denies and counts it.
    const globs = await start({ store: storeOf([guard("g1", [{ kind: "permission", action: "shell", resources: ["rm *"] }])], [activation("a1", "g1", "root")]) })
    expect((await globs.g.before(shell("root", "rm x"))).blocked).toBe(false)
    await globs.g.evaluate(evaluate("root", ["rm x"]))
    await settle()
    expect(globs.report().blockedCount).toBe(1)
  })

  test("a fail-closed block counts, and an allowed call does not", async () => {
    const t = await start({ store: '{"schema":"td-guards/1","revision":1,"guards":[{"bad":true}],"activations":[]}' })
    await t.g.before(shell("root", "ls"))
    await t.g.before({ sessionID: "root", tool: "read", input: {} })
    await settle()
    expect(t.report().blockedCount).toBe(1)
    const open = await start({ store: commitStore })
    await open.g.before(shell("root", "ls"))
    await open.g.before(shell("other", "git commit"))
    await settle()
    expect(open.report().blockedCount).toBe(0)
  })
})

describe("early shell gate: registration and disposal", () => {
  test("setup registers the evaluate hook and the early hook, and reports registered", async () => {
    const t = await start({ store: commitStore })
    expect(t.g.registered).toEqual(["permission.evaluate", "tool.execute.before"])
    expect(t.g.hookCount()).toBe(1)
    expect(t.g.earlyHookCount()).toBe(1)
    expect(t.report().registered).toBe(true)
  })

  test("cleanup disposes both hooks, reports registered:false, and a second cleanup is harmless", async () => {
    const t = await start({ store: commitStore })
    await t.cleanup()
    expect(t.g.state).toMatchObject({ evaluateDisposed: 1, earlyDisposed: 1 })
    expect(t.g.hookCount()).toBe(0)
    expect(t.g.earlyHookCount()).toBe(0)
    expect(t.report().registered).toBe(false)
    await t.cleanup()
    expect(t.g.state).toMatchObject({ evaluateDisposed: 1, earlyDisposed: 1 })
  })

  test("a disposal that rejects does not stop cleanup or the disposal of the other hook", async () => {
    const t = await start({ store: commitStore, failDispose: true })
    await expect(t.cleanup()).resolves.toBeUndefined()
    expect(t.g.state).toMatchObject({ evaluateDisposed: 1, earlyDisposed: 1 })
    expect(t.report().registered).toBe(false)
  })

  test("an early hook registration failure throws, disposes the evaluate hook, and reports registered:false", async () => {
    const fs = createMemoryFs()
    const g = createGuardCtx({ failToolHook: true })
    const log = createMemoryLogger()
    await expect(
      setupGuards(g.ctx, log, { fs, home: () => "/fake/home", setInterval: () => 1, clearInterval: () => {} }),
    ).rejects.toThrow("NOT enforced")
    expect(g.state.evaluateDisposed).toBe(1)
    expect(g.hookCount()).toBe(0)
    expect(g.earlyHookCount()).toBe(0)
    const parsed = parseRuntimeReport(JSON.parse(fs.files.get(REPORT_FILE)!))
    expect(parsed.ok && parsed.value.registered).toBe(false)
  })

  test("an early hook registration failure with a failing disposal still throws the setup error", async () => {
    const fs = createMemoryFs()
    const g = createGuardCtx({ failToolHook: true, failDispose: true })
    await expect(
      setupGuards(g.ctx, createMemoryLogger(), { fs, home: () => "/fake/home", setInterval: () => 1, clearInterval: () => {} }),
    ).rejects.toThrow("NOT enforced")
    expect(g.state.evaluateDisposed).toBe(1)
  })

  test("an evaluate hook registration failure registers no early hook", async () => {
    const fs = createMemoryFs()
    const g = createGuardCtx({ failHook: true })
    await expect(
      setupGuards(g.ctx, createMemoryLogger(), { fs, home: () => "/fake/home", setInterval: () => 1, clearInterval: () => {} }),
    ).rejects.toThrow("NOT enforced")
    expect(g.earlyHookCount()).toBe(0)
    expect(g.registered).toEqual([])
  })

  test("the plugin entry survives an early hook failure: it logs a fixed line, returns a cleanup, and the report says registered:false", async () => {
    const fs = createMemoryFs()
    const g = createGuardCtx({ failToolHook: true, directory: "/fake/project" })
    const plugin = createPlugin({ setupGuards: (ctx, log) => setupGuards(ctx, log, { fs, home: () => "/fake/home", setInterval: () => 1, clearInterval: () => {} }) })
    const originalError = console.error
    const lines: string[] = []
    console.error = (line: unknown) => void lines.push(String(line))
    try {
      const cleanup = await plugin.setup(g.ctx as never)
      expect(typeof cleanup).toBe("function")
      await (cleanup as () => Promise<void>)()
    } finally {
      console.error = originalError
    }
    expect(lines.join("\n")).toContain("Guards are NOT enforced")
    expect(g.hookCount()).toBe(0) // The evaluate hook that did register was disposed, so no half-enforcement is left.
    expect(g.earlyHookCount()).toBe(0)
    const parsed = parseRuntimeReport(JSON.parse(fs.files.get(REPORT_FILE)!))
    expect(parsed.ok && parsed.value.registered).toBe(false)
  })
})
