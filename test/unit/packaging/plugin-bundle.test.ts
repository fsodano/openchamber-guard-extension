import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { buildPlugin, externalImports, normalizeModuleComments } from "../../../scripts/build-extension-plugin.ts"
import { guardPaths } from "../../../src/guards/store.ts"
import { createPlugin, PLUGIN_ID } from "../../../src/index.ts"

const ROOT = new URL("../../..", import.meta.url).pathname

interface Manifest {
  name: string
  version: string
  files: string[]
  scripts?: Record<string, string>
  openchamber: {
    apiVersion: number
    engines: { openchamber: string }
    id: string
    name: string
    icon: string
    contributes: {
      panel: { entry: string }
      statusSection: { entry: string; title: string; height: number; requiresProject: boolean }
      capabilities: string[]
      service: { entry: string; runtime: string; provides: string[] }
      filesystem?: string[]
      opencodePlugin: string
    }
  }
}

const readJson = async <T>(path: string): Promise<T> => JSON.parse(await readFile(path, "utf8")) as T

describe("package manifest", () => {
  test("has no script that makes npm prepare a git install", async () => {
    const pkg = await readJson<Manifest>(join(ROOT, "package.json"))
    const triggers = ["build", "prepare", "prepack", "preinstall", "install", "postinstall"]
    expect(triggers.filter((name) => pkg.scripts?.[name] !== undefined)).toEqual([])
  })

  test("declares the guard extension with its own OpenCode plugin", async () => {
    const pkg = await readJson<Manifest>(join(ROOT, "package.json"))
    expect(pkg.name).toBe("openchamber-guard-extension")
    expect(pkg.openchamber.id).toBe("openchamber-guard-extension")
    expect(pkg.openchamber.icon).toBe("extension/icon.svg")
    expect(pkg.openchamber.engines).toEqual({ openchamber: ">=2.7.0" })
    const { contributes } = pkg.openchamber
    expect(contributes.service).toEqual({ entry: "extension/service/main.js", runtime: "host", provides: ["opencode"] })
    expect(contributes.opencodePlugin).toBe("extension/plugin")
    expect(contributes.capabilities).toEqual(["model", "sessions"])
    // The model-check status files belong to the other plugin. This extension reads none of them.
    expect(JSON.stringify(pkg.openchamber)).not.toContain("status/")
    expect(JSON.stringify(pkg.openchamber)).not.toMatch(/fuelix/i)
  })

  test("every manifest asset exists and is listed in files, with no broad globs", async () => {
    const pkg = await readJson<Manifest>(join(ROOT, "package.json"))
    const { icon, contributes } = pkg.openchamber
    const assets = [
      icon,
      contributes.panel.entry,
      "extension/panel/main.js",
      contributes.statusSection.entry,
      "extension/panel/status.js",
      contributes.service.entry,
      `${contributes.opencodePlugin}/index.js`,
    ]
    for (const asset of assets) {
      expect(existsSync(join(ROOT, asset))).toBe(true)
      expect(pkg.files).toContain(asset)
    }
    for (const file of pkg.files) expect(file).not.toMatch(/\*/)
    expect(pkg.files).not.toContain("src")
    expect(pkg.files).not.toContain("extension")
  })
})

describe("generated plugin bundle", () => {
  test("is current with the source", async () => {
    const committed = await readFile(join(ROOT, "extension/plugin/index.js"), "utf8")
    expect(committed).toBe(await buildPlugin())
  }, 30_000)

  test("imports only Node built-in modules", async () => {
    const committed = await readFile(join(ROOT, "extension/plugin/index.js"), "utf8")
    expect(externalImports(committed)).toEqual([])
    expect(externalImports(`import x from "zod"\nimport { a } from "node:fs"\nawait import("@opencode/plugin")`)).toEqual([
      "@opencode/plugin",
      "zod",
    ])
  })

  test("contains no FueliX, Jev, or TypeSafe code", async () => {
    const committed = await readFile(join(ROOT, "extension/plugin/index.js"), "utf8")
    expect(committed).not.toMatch(/fuelix|jev|typesafe|keychain/i)
  })

  test("has a version banner that matches the package version", async () => {
    const pkg = await readJson<Manifest>(join(ROOT, "package.json"))
    const committed = await readFile(join(ROOT, "extension/plugin/index.js"), "utf8")
    expect(committed.startsWith(`// ${pkg.name} v${pkg.version}.`)).toBe(true)
  })
})

describe("plugin build is independent of the working directory", () => {
  const script = resolve(ROOT, "scripts/build-extension-plugin.ts")

  /** Runs `buildPlugin()` in a child process, so each run has its own `process.cwd()`. */
  async function buildFrom(cwd: string): Promise<string> {
    const code = `import { buildPlugin } from ${JSON.stringify(script)}; process.stdout.write(await buildPlugin())`
    const child = Bun.spawn([process.execPath, "-e", code], { cwd, stdout: "pipe", stderr: "pipe" })
    const [exit, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    if (exit !== 0) throw new Error(`build from ${cwd} exited with ${exit}: ${stderr}`)
    return stdout
  }

  test("the artifact is identical from the package, its parent, and an unrelated directory", async () => {
    const committed = await readFile(join(ROOT, "extension/plugin/index.js"), "utf8")
    const unrelated = await mkdtemp(join(tmpdir(), "guard-build-cwd-"))
    try {
      for (const cwd of [ROOT, dirname(ROOT.replace(/\/$/, "")), unrelated]) {
        const built = await buildFrom(cwd)
        expect(built).toBe(committed)
        expect(built).toContain("\n// src/guards/index.ts\n")
        expect(built).not.toContain("// openchamber-guard-extension/src/")
        expect(built).not.toMatch(/sourceMappingURL/)
      }
    } finally {
      await rm(unrelated, { recursive: true, force: true })
    }
  }, 60_000)

  test("`--check` passes from the parent directory", async () => {
    const child = Bun.spawn([process.execPath, script, "--check"], { cwd: dirname(ROOT.replace(/\/$/, "")), stdout: "pipe", stderr: "pipe" })
    const [exit, stdout] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(stdout).toContain("up to date")
    expect(exit).toBe(0)
  }, 30_000)

  test("normalizeModuleComments rewrites module paths against the package root only", () => {
    const root = "/work/pkg"
    const code = "// openchamber-guard-extension v0.1.0. Generated by x. Do not edit.\n// pkg/src/a.ts\n// /elsewhere/b.ts\nconst x = 1 // pkg/src/c.ts\n"
    expect(normalizeModuleComments(code, "/work", root)).toBe(
      "// openchamber-guard-extension v0.1.0. Generated by x. Do not edit.\n// src/a.ts\n// /elsewhere/b.ts\nconst x = 1 // pkg/src/c.ts\n",
    )
    expect(normalizeModuleComments("// src/a.ts\n", root, root)).toBe("// src/a.ts\n")
  })
})

describe("plugin source", () => {
  test("has its own id and stores guards under its own directory", () => {
    expect(PLUGIN_ID).toBe("openchamber-guard-extension")
    expect(createPlugin().id).toBe(PLUGIN_ID)
    expect(guardPaths("/h").root).toBe("/h/.openchamber-guard-extension/guards")
  })

  test("service and plugin read the same store location", async () => {
    const main = await readFile(join(ROOT, "extension/service/main.ts"), "utf8")
    expect(main).toContain('root: join(homedir(), ".openchamber-guard-extension")')
  })

  test("a setup failure is logged without the error body and returns a cleanup", async () => {
    const secret = "secret-error-body-must-not-be-logged"
    const plugin = createPlugin({
      setupGuards: (async () => {
        throw new Error(secret)
      }) as never,
    })
    const originalError = console.error
    const lines: string[] = []
    console.error = (line: unknown) => void lines.push(String(line))
    try {
      const cleanup = await plugin.setup({ options: {} } as never)
      expect(typeof cleanup).toBe("function")
      await (cleanup as () => Promise<void>)()
    } finally {
      console.error = originalError
    }
    expect(lines.join("\n")).toContain("Guards are NOT enforced")
    expect(lines.join("\n")).not.toContain(secret)
  })
})

/** Result that the child process prints for one plugin run. */
interface RunResult {
  id: unknown
  setupType: unknown
  touched: string[]
  permissionHooks: string[]
  toolHooks: string[]
  guardRuntime: Array<{ registered: boolean; coveredActions: string[]; storeState: string }>
}

describe("plugin bundle in the shipped package layout", () => {
  let packageDir: string

  beforeAll(async () => {
    packageDir = await mkdtemp(join(tmpdir(), "guard-package-"))
    // Copy only what the package ships for the plugin. The copied `package.json` marks `index.js` as an ES module.
    // The source tree stays out, so the run proves that the bundle needs no `src/` and no `node_modules/`.
    for (const entry of ["extension/plugin/index.js", "package.json"]) {
      await mkdir(dirname(join(packageDir, entry)), { recursive: true })
      await cp(join(ROOT, entry), join(packageDir, entry))
    }
  })

  afterAll(async () => {
    await rm(packageDir, { recursive: true, force: true })
  })

  test("registers only the evaluate and early shell hooks, touches no provider or integration, and writes its runtime report", async () => {
    const home = await mkdtemp(join(tmpdir(), "guard-bundle-home-"))
    try {
      const script = join(home, "run.mjs")
      await Bun.write(
        script,
        `
import plugin from ${JSON.stringify(join(packageDir, "extension/plugin/index.js"))}
const touched = new Set()
const permissionHooks = []
const toolHooks = []
const target = {
  options: {},
  location: { directory: "/isolated/location" },
  session: { get: async () => ({}) },
  permission: { hook: async (name) => (permissionHooks.push(name), { dispose: async () => {} }) },
  tool: { hook: async (name) => (toolHooks.push(name), { dispose: async () => {} }) },
  event: { subscribe: async function* () {} },
}
// Records every namespace that the plugin reads from the context.
const ctx = new Proxy(target, { get: (object, key) => (touched.add(String(key)), object[key]) })
const cleanup = await plugin.setup(ctx)
await new Promise((resolve) => setTimeout(resolve, 600))
const { readdir, readFile } = await import("node:fs/promises")
const runtimeDir = process.env.HOME + "/.openchamber-guard-extension/guards/runtime"
const guardRuntime = []
for (const name of await readdir(runtimeDir).catch(() => [])) guardRuntime.push(JSON.parse(await readFile(runtimeDir + "/" + name, "utf8")))
console.log("RESULT " + JSON.stringify({
  id: plugin.id,
  setupType: typeof plugin.setup,
  touched: [...touched].sort(),
  permissionHooks,
  toolHooks,
  guardRuntime: guardRuntime.map((report) => ({ registered: report.registered, coveredActions: report.coveredActions, storeState: report.storeState })),
}))
await cleanup()
process.exit(0)
`,
      )
      const env: Record<string, string> = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        XDG_CONFIG_HOME: join(home, "config"),
        XDG_DATA_HOME: join(home, "data"),
        XDG_STATE_HOME: join(home, "state"),
        XDG_CACHE_HOME: join(home, "cache"),
      }
      const child = Bun.spawn([process.execPath, script], { env, cwd: home, stdout: "pipe", stderr: "pipe" })
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (code !== 0) throw new Error(`bundle subprocess exited with ${code}: ${stderr}`)
      const line = stdout.split("\n").find((entry) => entry.startsWith("RESULT "))
      if (!line) throw new Error(`bundle subprocess printed no result: ${stdout}${stderr}`)
      const result = JSON.parse(line.slice("RESULT ".length)) as RunResult
      expect(result.id).toBe("openchamber-guard-extension")
      expect(result.setupType).toBe("function")
      expect(result.permissionHooks).toEqual(["evaluate"])
      expect(result.toolHooks).toEqual(["execute.before"])
      expect(result.touched.every((key) => ["event", "location", "permission", "session", "then", "tool"].includes(key))).toBe(true)
      expect(result.guardRuntime).toEqual([{ registered: true, coveredActions: ["shell", "subagent"], storeState: "missing" }])
      // Only the guard folder appears below the home directory.
      expect(existsSync(join(home, ".openchamber-guard-extension", "status"))).toBe(false)
    } finally {
      await rm(home, { recursive: true, force: true })
    }
  }, 30_000)
})
