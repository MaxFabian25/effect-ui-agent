# effect-ui-agent

A production end-user agent bridge and WebMCP layer for [`@effect/ui`](https://github.com/Effect-TS/ui).

`@effect/ui-devtools` gives developer agents access to raw message logs and time-travel debugging on loopback. `effect-ui-agent` solves the production counterpart: letting an embedded assistant or a browser agent (via WebMCP `document.modelContext`) read safe component state and run allow-listed, Schema-validated user actions with human confirmation gates and `Schema.Redacted` secret protection.

## Properties

- **Fail-closed component contracts.** Components opt in via `expose(Component, spec)` with a label, optional `hidden(model)` predicate, projected `state(model)`, and an explicit `actions` map. Internal messages such as popup toggles are never exposed.
- **Schema boundary validation and JSON Schema.** Each action declares an Effect `Schema`. `snapshot()` generates draft-2020-12 JSON Schemas via `Schema.toJsonSchemaDocument`, and `act()` decodes inputs with `{ onExcessProperty: "error" }`.
- **Write-only secrets with `Schema.Redacted`.** Actions that accept secrets use `Schema.RedactedFromValue(Schema.String)` and `secret: true`. `AgentBridge` recursively scrubs any `Redacted` value in `snapshot()` and redacts secret arguments in its audit log.
- **Live-Model confirmation gates.** `confirm: (model, args) => string` computes confirmation text from the current Model. Confirmed actions fail closed when no `allow` callback is supplied and abort cleanly when the user declines.
- **Pre-dispatch argument checks.** Optional `check: (model, args) => string | undefined` validates decoded arguments against the live Model immediately before dispatch (and again after a pending `allow` approval, alongside visibility, `enabled`, label, and confirmation text). Returning a refusal string stops the batch, records the failure in the audit log, and preserves the count of earlier completed steps. Refusal strings are returned to the caller and recorded in the audit log, so return safe public text without secrets.
- **Agent source awareness.** Actions pass `{ source: "agent" }` into `toMessage` so `update` can distinguish and refuse agent edits under workspace policy while human interactions still work.
- **Coexistence with `@effect/ui-devtools`.** `layer()` chains onto any upstream `MessageLog.MessageLog` (via `MessageLog.fanoutAll`) and `BrowserHost.Controllables`, so both `AgentBridge` and `DevTools.layer()` receive every mounted root and log entry.
- **Scoped WebMCP registration.** `registerWebMcp(document.modelContext, { prefix, allow })` registers `snapshot`, `query`, and `act` tools and aborts every registration when the Effect `Scope` closes.

## Usage

```ts
import { BrowserHost } from "@effect/ui/html"
import { Effect, Layer, Redacted, Schema } from "effect"
import * as AgentBridge from "effect-ui-agent"
import { ProjectSettings, SettingsMessage, Visibility } from "./ProjectSettings.ts"

const ProjectSettingsAgent = AgentBridge.expose(ProjectSettings, {
  label: "Project settings",
  hidden: (model) => model.showingRecoveryCodes,
  state: (model) => ({
    name: model.name,
    visibility: model.visibility,
    hasApiKey: Redacted.value(model.apiKey).length > 0
  }),
  actions: {
    setName: {
      description: "Rename the project",
      args: Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1)) }),
      toMessage: ({ name }, { source }) => SettingsMessage.UpdatedName({ name, source })
    },
    setVisibility: {
      description: "Change project visibility",
      args: Schema.Struct({ visibility: Visibility }),
      toMessage: ({ visibility }, { source }) =>
        SettingsMessage.PickedVisibility({ visibility, source })
    },
    setApiKey: {
      description: "Update the project API key (write-only secret)",
      secret: true,
      args: Schema.Struct({ apiKey: Schema.RedactedFromValue(Schema.String) }),
      toMessage: ({ apiKey }, { source }) => SettingsMessage.UpdatedApiKey({ apiKey, source })
    },
    deleteProject: {
      description: "Permanently delete the project and all its files",
      confirm: (model) => `Deletes "${model.name}" and all its files`,
      enabled: (model) => !model.deleted,
      args: Schema.Struct({}),
      toMessage: (_args, { source }) => SettingsMessage.DeletedProject({ source })
    }
  }
})

const Main = BrowserHost.mount(ProjectSettings, {}, document.getElementById("app")!).pipe(
  Layer.provide(
    AgentBridge.layer({
      contracts: [ProjectSettingsAgent],
      allow: (request) => window.confirm(request.confirm)
    })
  )
)

Effect.runFork(Layer.launch(Main))
```

To expose the bridge to browser agents through WebMCP:

```ts
const bridge = yield* AgentBridge.AgentBridgeService
if ("modelContext" in document && document.modelContext) {
  yield* bridge.registerWebMcp(document.modelContext, {
    prefix: "app_",
    allow: (request) => askUser(request.confirm)
  })
}
```

## Find rows in one visible list

Add `rows(model)` to a component contract to make its list searchable. Return only public string `id` and `label` values with `status: "ready"`. Use each record's stable ID, so rows with the same label remain distinct. For a list that is not ready, return `status: "loading"`, `"refreshing"`, or `"failed"` without rows.

```ts
const ReviewQueueAgent = AgentBridge.expose(ReviewQueue, {
	label: "Review queue",
	state: () => ({}),
	rows: ({ status, reviews }) => status === "ready"
		? { status, rows: reviews.map(({ id, name }) => ({ id, label: name })) }
		: { status },
	actions: {}
})

bridge.queryRows({ ref: "Review queue", text: "Payroll", limit: 5 })
```

`queryRows` requires an exact component path or an exact unique visible label. A caller that knows the label can search without taking a snapshot. For a label shared by several lists, use the exact `ref` from `snapshot()` or `query()`. An absent, hidden, ambiguous, or non-opted-in component returns `{ status: "unavailable" }`.

Text matches a case-insensitive substring of the row's ID or label. Results stay in the order supplied by the contract. `offset` counts matching rows and defaults to `0`. `limit` defaults to `10` and accepts integers from `1` to `50`. Invalid inputs raise a `SchemaError`. For a ready result, `more` indicates whether another page of matches exists. When `more` is true, add the number of returned rows to `offset` for the next request. Each request reads the current list. A successful search with no matches returns `{ status: "ready", rows: [], more: false }`.

When at least one contract opts in, WebMCP adds the read-only `ui_query_rows` tool with the same input and result. A configured tool prefix replaces `ui_`. Looking up rows does not dispatch an action or change what `snapshot()` and `query()` return. Use `act()` separately if the component exposes an action for a row.

## Testing

Under `TestHost` and `HtmlPlay`, attach the mounted test root with `attachTestRoot(bridge, play.root)` to run `snapshot()`, `query()`, `act()`, and WebMCP tests without a browser.

Use `effect-ui-agent/testing` to assert what the mounted bridge advertises in a given screen state:

```ts
import { assertActionDiscoverable, assertActionNotDiscoverable } from "effect-ui-agent/testing"

assertActionDiscoverable(bridge, { label: "Project settings", action: "setName" })
assertActionNotDiscoverable(bridge, { label: "Project settings", action: "showRecoveryCodes" })
```

The assertions require exactly one match or zero matches, respectively. The action name and
target are exact and case-sensitive. If multiple targets share a label, use the full snapshot
`ref` in place of `label`, for example `{ ref: "/Workspace/ProjectSettings[beta]", action: "setName" }`.
Supply the expected target and action from the test scenario. Pair an absence check with a
positive check when you also need to verify that the intended component is mounted and visible.

The helpers work with any test runner. They read `snapshot()` synchronously and distinguish
missing actions, ambiguous matches, and unexpected exposure without printing snapshot contents.
A confirmation-gated action can still be discoverable. Test dispatch, authorisation, and the
resulting UI separately with `act()`.

For multi-level component trees with nested child dispatch, mount with `BrowserHost.mountEffect` in `happy-dom` (see `tests/BrowserHost.test.ts`), because `BrowserHost.Controllables` exposes `root.instance(id)` for every nested child whereas `TestHost.Root` currently exposes `root.send` only on the root.

## Development

```sh
bun install
bun run check
bun run build
bun test
```

## License

MIT
