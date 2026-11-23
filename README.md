# OpenChamber guard extension

Save execution guards and enable them for an OpenCode session or request. The extension includes the guard controls,
an authenticated local service, and an OpenCode plugin that rejects matching permission-checked actions.

## Install

OpenChamber 2.7.0 or later is required. In **Settings -> Extensions**, add this package's root folder and approve its
model, session, service, and OpenCode plugin permissions. OpenChamber installs the bundled plugin on its managed local
OpenCode server. Wait for **Enforced by the plugin** before relying on a guard.

Older versions of `td-opencode-plugin` include guards. Install this extension and confirm that its
`openchamber-guard-extension` plugin is running before updating TD-Plugin to a version without guards. Otherwise, active
guards stop being enforced. Both plugins can enforce the same store during the transition. Existing definitions and
activations remain in `~/.td-opencode-plugin/guards/`.

Read the [guard guide](docs/guards.md) for scope, release, data handling, and enforcement limits.

## Development

```bash
bun install
bun run build:all
bun run test
bun run typecheck
bun run extension:check
bun run test:integration
```

The integration tests use isolated OpenCode servers and a local mock model. The shipped JavaScript is built before
installation; OpenChamber does not compile TypeScript.
