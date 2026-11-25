# OpenChamber guard extension

OpenChamber Guard Extension lets you define guards that block actions you do not want the agent to run, such as Git
commits or edits to `.env` files. You describe the guard in plain language, and a Small Model turns it into a
code-enforced rule.

A **guard** is a saved list of rules. You can enable a guard for a session or for a single request; the panel labels
those scopes **This session** and **This request**.

The extension has three parts: guard controls in an OpenChamber panel, an authenticated local service that saves guards
and records where they are enabled, and a bundled OpenCode plugin that denies matching actions before OpenCode runs
them.

![Guard panel with an active guard](docs/guard-panel.png)

*The running panel shows the enforcement status and one active guard.*

## How a guard works

The panel turns a plain-language request into validated rules, saves them through the local service, and the plugin
enforces them inside OpenCode. The sequence shows one full cycle; the C4 views show the same pieces at system and
container level.

**Sequence diagram: creating and enforcing a guard.**

```mermaid
sequenceDiagram
    autonumber
    actor user as User
    participant panel as Guards panel
    participant host as OpenChamber host
    participant model as Small Model
    participant service as Local guard service
    participant store as Guard store
    participant opencode as OpenCode server
    participant plugin as Guard plugin
    participant agent as Agent

    user->>panel: Enters a guard request
    panel->>host: Requests a draft
    host->>model: Sends the request
    model-->>host: Returns draft rules
    host-->>panel: Returns the draft
    panel->>panel: Validates rules and shows the tester
    user->>panel: Selects Save guard
    panel->>host: Saves the guard
    host->>service: Forwards the save
    service->>store: Writes the guard
    user->>panel: Enables the guard
    panel->>host: Creates an activation
    host->>service: Forwards the activation
    service->>store: Writes the activation
    opencode->>plugin: Asks permission for an action
    plugin->>store: Reads active guards
    store-->>plugin: Returns matching rules
    plugin-->>opencode: Denies the action
    opencode-->>agent: Returns a tool error
    agent->>agent: Continues with other work
```

**System Context diagram for OpenChamber Guard Extension (C4 L1).**

```mermaid
flowchart TB
    user["<b>User</b><br/>«Person»<br/>Defines and enables guards"]
    extension["<b>OpenChamber Guard Extension</b><br/>«Software System»<br/>Defines, stores, and enforces agent action guards"]
    host["<b>OpenChamber host</b><br/>«Software System, external»<br/>Hosts the panel and service; provides model and session access"]
    opencode["<b>OpenCode server</b><br/>«Software System, external»<br/>Runs the agent and loads the bundled plugin"]
    model["<b>Small Model</b><br/>«Software System, external»<br/>Turns plain-language requests into guard rules"]

    user -->|"Defines and enables guards in"| extension
    extension -->|"Runs the panel and service inside"| host
    host -->|"Sends guard requests to"| model
    extension -->|"Enforces guards in"| opencode
    host -->|"Manages the local server"| opencode

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef system fill:#1168bd,stroke:#0b4884,color:#fff
    classDef external fill:#999,stroke:#6b6b6b,color:#fff
    classDef hidden fill:none,stroke:none,color:transparent
    class user person
    class extension system
    class host,opencode,model external

    subgraph Legend
        direction LR
        l1["Person"]:::person
        l2["Software System (in scope)"]:::system
        l3["Software System (external)"]:::external
    end
    bottomNode[" "]:::hidden
    bottomNode ~~~ Legend
```

**Container diagram for OpenChamber Guard Extension (C4 L2).**

```mermaid
flowchart TB
    user["<b>User</b><br/>«Person»<br/>Defines and enables guards"]
    host["<b>OpenChamber host</b><br/>«Software System, external»<br/>Hosts the panel and service; provides model and session access"]
    opencode["<b>OpenCode server</b><br/>«Software System, external»<br/>Runs the agent"]
    model["<b>Small Model</b><br/>«Software System, external»<br/>Drafts guard rules"]

    subgraph boundary["OpenChamber Guard Extension [Software System]"]
        panel["<b>Guards panel</b><br/>«Container: TypeScript, HTML»<br/>Creates, previews, saves, enables, and releases guards"]
        service["<b>Local guard service</b><br/>«Container: Node.js, host runtime»<br/>Validates changes and writes the guard store"]
        store[("<b>Guard store</b><br/>«Container: JSON file»<br/>Saved guards, activations, lifecycle facts, runtime snapshots")]
        plugin["<b>Guard plugin</b><br/>«Container: TypeScript, OpenCode plugin»<br/>Denies matching permission-checked actions"]
    end

    user -->|"Defines and enables guards in [UI]"| panel
    panel -->|"Requests drafts and service calls [JSON postMessage]"| host
    host -->|"Sends guard requests to [host model API]"| model
    host -->|"Starts and proxies the service [HTTP on localhost]"| service
    service -->|"Reads and writes guards [file I/O]"| store
    service -->|"Resolves session parent links [OpenCode API]"| opencode
    opencode -->|"Loads the plugin and invokes its permission hook [in-process]"| plugin
    plugin -->|"Reads active guards and writes lifecycle facts [file I/O]"| store

    classDef person fill:#08427b,stroke:#052e56,color:#fff
    classDef container fill:#438dd5,stroke:#2e6295,color:#fff
    classDef datastore fill:#2e6da4,stroke:#1b4f72,color:#fff
    classDef external fill:#999,stroke:#6b6b6b,color:#fff
    classDef hidden fill:none,stroke:none,color:transparent
    class user person
    class panel,service,plugin container
    class store datastore
    class host,opencode,model external

    subgraph Legend
        direction LR
        l1["Person"]:::person
        l2["Container"]:::container
        l3[("Data store / file")]:::datastore
        l4["External system"]:::external
    end
    bottomNode[" "]:::hidden
    bottomNode ~~~ Legend
```

## Install and verify

The package declares OpenChamber `>=2.7.0` in its [manifest](package.json).

1. In OpenChamber, add the package root or the repository URL under **Settings -> Extensions**. To do this from an
   agent, see [Agent fast path](#agent-fast-path).
2. Approve access to the Small Model, sessions, local service, and bundled OpenCode plugin. The service runs with your
   full user privileges, outside the panel sandbox.
3. Open the Guards panel in a session. OpenChamber installs the bundled plugin on its managed local OpenCode server.
4. Wait for **Enforced by the plugin** before relying on a guard.

That status comes from a fresh plugin runtime report for the current location. It confirms the plugin has registered its
enforcement check and can use the saved guard state there. A missing, stale, or unreadable report does not confirm
enforcement; existing rules may still be active.

### Agent fast path

An agent can install or reinstall `https://github.com/fsodano/openchamber-guard-extension` through OpenChamber's local
API. The UI equivalent is **Settings -> Extensions -> add by URL**.

1. Read `desktopLocalPort` from `~/.config/openchamber/settings.json` and use `http://127.0.0.1:<port>` as the base URL.
   The port can change; read it each time instead of hardcoding a value.

2. Install or reinstall. Omit `"replace":true` on a clean install.

   ```bash
   curl -sS -X POST http://127.0.0.1:<port>/api/guests \
     -H 'content-type: application/json' \
     -d '{"url":"https://github.com/fsodano/openchamber-guard-extension","replace":true}'
   ```

   OpenChamber clones the private repository into
   `~/.config/openchamber/extensions/openchamber-guard-extension`. Git credentials must already work on the machine
   (gh CLI or a credential helper). The built JavaScript is committed, so no `bun install` or build step is needed. The
   response includes the id `openchamber-guard-extension` and `capabilities.requested`.

3. A reinstall resets the grants. Grant the requested capabilities exactly.

   ```bash
   curl -sS -X PUT http://127.0.0.1:<port>/api/guests/openchamber-guard-extension/capabilities \
     -H 'content-type: application/json' \
     -d '{"granted":["sessions","model","service","opencodePlugin","opencode"]}'
   ```

   The granted list must match `capabilities.requested` exactly.

4. Wake the service and wait for it to report ready.

   ```bash
   curl -sS -X POST http://127.0.0.1:<port>/api/guests/openchamber-guard-extension/service/request \
     -H 'content-type: application/json' \
     -d '{"method":"GET","path":"/health"}'
   curl -sS http://127.0.0.1:<port>/api/guests/openchamber-guard-extension/service/status
   ```

   The first call returns `{"status":200,"body":"{\"ok\":true}"}`. The second returns `{"status":"ready"}`.

5. Verify the install.

   ```bash
   curl -sS http://127.0.0.1:<port>/api/guests
   ```

   The extension entry must show `source: "git"`, `origin.url` set to the repository URL, `enabled: true`,
   `service.granted: true`, and `opencodePlugin: true`. If the Guards panel does not say **Enforced by the plugin**,
   restart OpenChamber so the managed OpenCode server loads the plugin.

Do not use the `marketplace_manage` tool for this. Its `import` action expects a manifest with `schemaVersion` 2 or 3,
and its `install` action expects a registry selector.

## Use the panel

1. Open **Guards** in the session where the guard should apply.

   ![Guards panel with the enforcement status, one active guard, and the saved guards list](docs/steps/step-1.png)

2. In **New guard**, enter a plain-text guard request such as “block Git commits” and select **Generate preview**. Each
   click sends the request to your Small Model and uses tokens.

   ![New guard request filled in and the Generate preview button enabled](docs/steps/step-2.png)

3. Review the proposed rules, description, and message the agent will see. The request and description do not enforce
   anything; the validated rules do. The draft is data, not executable code.

   ![Draft preview showing the rules, the model description, and the message the agent sees](docs/steps/step-3.png)

4. Test sample commands in the preview. The tester checks the same rules as the plugin but never runs a command. If it
   cannot interpret a command exactly, it may report that the guard would block it.

   ![Command tester reporting that git commit would be blocked by rule 1](docs/steps/step-4.png)

5. Select **Save guard**. Saving adds the guard to **Saved guards** but leaves it off.

   ![Saved guard shown as off with its Enable and Delete controls](docs/steps/step-5.png)

6. Select **Enable…** on a saved guard and choose its scope. **This session** is the default; expiry is off until you
   select it.

   ![Enable form with This session selected and the This request and automatic expiry options](docs/steps/step-6.png)

The two scopes apply as follows:

- **This session** applies to the current chat session and its linked subagents (child sessions OpenCode links to it) until
  you release it or its optional expiry.
- **This request** applies to the current OpenCode run, or the next run if the session is idle, and its linked
  subagents. OpenCode events do not include a run identifier, so the plugin releases this scope automatically only when
  it can confirm that the tracked run and its descendants ended. If completion is uncertain, the guard stays on until
  you release it or its optional expiry.

A session without a recorded parent link does not inherit another session's guards. **Release** turns a guard off.
Deleting a saved guard turns it off everywhere; other active guards can still block the same action.

## What guards can match

The extension supports two rule types. Both apply only to actions that OpenCode sends through permission checks.

### Command rules

A command rule matches an executable name (not a path) when OpenCode asks permission to run a shell command. It can
also match optional subcommand prefixes (initial word sequences after the executable and its global options) and literal
flags. If several subcommand alternatives are listed, any one may match. If flags are listed, all of them must appear.

Illustrative example from the [guard guide](docs/guards.md): a rule for executable `git` and subcommand `commit` matches
`git commit -m "wip"`. It does not also block `git merge` or `git rebase` unless you add those operations.

### Permission rules

A permission rule matches one exact OpenCode permission action, such as `edit`, and optionally resource patterns that
limit which resources the rule covers. Without resource patterns, it matches any resource for that action. It applies
only when a tool requests that permission action; it is not a filter for every tool with a particular name. Resource
patterns use simple wildcards rather than regular expressions: `*` matches within one path segment, `**` can cross `/`,
and `?` matches one non-`/` character.

### Guard limits

The schema in [`src/guards/schema.ts`](src/guards/schema.ts) enforces these bounds:

- Each guard must have 1 to 16 rules.
- A command rule can have up to 16 subcommand alternatives, each up to 8 words, and up to 16 literal flags.
- A permission rule can have up to 16 resource patterns.
- The global store can hold up to 256 saved guards and 1,024 enabled guards. Text fields and the store file have
  separate size limits in the schema.

## Enforcement boundaries

A matching permission-checked action is denied before execution, even if ordinary permissions would allow it. OpenCode
returns a tool error and the agent can continue with other work. A guard cannot stop an action that has already started.

Guards are not an operating-system security boundary. The agent runs as your operating-system user and could alter guard
files or automate user controls. The plugin exposes no model tool, command, or RPC for managing guards, but that does not
prevent those operating-system actions.

Command matching cannot reliably detect operations hidden inside arbitrary scripts, aliases, or other programs. A tool
that never requests permission does not pass through the guard checks. A plugin registered later can also change a
permission decision.

Some shell rules with resource patterns are checked during permission evaluation rather than the plugin's early command
check. An earlier hook, such as Jev, may send the command to its service before the guard denies it. Review other
plugins' data handling.

## Storage, data, and recovery

Saved guards and their enabled state are global across projects on this computer. The service writes them to a local
store and the plugin reads it; both must use the same guard directory. Separate hosts without a shared directory do not
share guards. Guard data does not change permanent OpenCode configuration.

The local service runs with your full user privileges, outside the panel sandbox. The panel sends a request to the Small
Model only when you select **Generate preview**; it does not read project files or conversations, send prompts to chat
sessions, or change sessions. Session information and parent links are used to apply guards to subagents. Guard requests
are saved as your data, so do not include credentials in requests or sample commands. Plugin status reports and records
used to track request-scope completion do not include live command text or permission-resource values.

An extension update or restart does not release guards enabled for a session. Pausing or removing the extension does
not remove the global store. Release those guards before removing the extension, or keep a working guard-management
control available.

If an existing store becomes unreadable or disappears, the plugin keeps its last valid copy. Invalid initial state
blocks supported mutating actions (shell, edit, write, patch, and subagent actions) until the store is repaired; a store
missing on the first read means there are no saved guards. If the service reports damaged data, existing rules may still
be active. Recovery requires a user confirmation, deletes all saved guards and releases all enabled guards across
every project, and keeps a backup of the damaged file. Only the confirmed user control can start recovery; the model
cannot request it through a guard-management tool. Cancelling leaves the current state unchanged. A failed recovery is
not a release; wait for the plugin to report the valid replacement state.

See [docs/guards.md](docs/guards.md) for the full scope and release behavior, data handling, recovery steps, and
enforcement limits.

## Development

The commands below are defined in [`package.json`](package.json). Build the shipped JavaScript before installing the
extension; OpenChamber does not compile TypeScript. Node 26 is the supported runtime for the host service; `.nvmrc` and
`.node-version` pin the major version. The build and tests use Bun.

```bash
bun install
bun run build:all
bun run test
bun run typecheck
bun run extension:check
bun run test:integration
```

The separate panel preview under `extension/test/preview/` is for development and is not part of the installed package.
