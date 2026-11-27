import { Component, MessageLog } from "@effect/ui"
import { BrowserHost } from "@effect/ui/html"
import { TestHost } from "@effect/ui/testing"
import { Context, Effect, Layer, Redacted, Schema, Scope } from "effect"

export type ActionSource = "user" | "agent"

export interface AgentActionSpec<Model, Msg, Args = any> {
  readonly description: string
  readonly args: Schema.Codec<Args, any, never, never>
  readonly secret?: boolean | undefined
  readonly confirm?: string | ((model: Model, args: Args) => string) | undefined
  readonly enabled?: ((model: Model) => boolean) | undefined
  readonly toMessage: (args: Args, meta: { readonly source: "agent" }) => Msg
}

export interface AgentContract<Model = any, Msg = any> {
  readonly component: Component.Any
  readonly componentName: string
  readonly label: string | ((model: Model) => string)
  readonly hidden?: ((model: Model) => boolean) | undefined
  readonly state: (model: Model) => Record<string, unknown>
  readonly actions: Record<string, AgentActionSpec<Model, Msg, any>>
}

export const expose = <C extends Component.Any>(
  component: C,
  spec: Omit<AgentContract<Component.Model<C>, Component.Message<C>>, "component" | "componentName">
): AgentContract<Component.Model<C>, Component.Message<C>> => ({
  component,
  componentName: (component as { readonly displayName?: string; readonly name?: string }).displayName ?? component.name ?? "Component",
  ...spec
})

export interface SnapshotAction {
  readonly name: string
  readonly description: string
  readonly inputSchema: object
  readonly confirm?: string | undefined
  readonly secret?: boolean | undefined
}

export interface SnapshotEntry {
  readonly ref: string
  readonly instance: number
  readonly component: string
  readonly label: string
  readonly state: Record<string, unknown>
  readonly actions: ReadonlyArray<SnapshotAction>
}

export interface AgentStepInput {
  readonly ref: string
  readonly action: string
  readonly args?: unknown
}

export interface AllowRequest {
  readonly ref: string
  readonly label: string
  readonly action: string
  readonly confirm: string
  readonly args: unknown
}

export type AllowCallback = (
  request: AllowRequest,
  context: { readonly signal?: AbortSignal | undefined }
) => boolean | Promise<boolean>

export interface AuditEntry {
  readonly ref: string
  readonly label: string
  readonly action: string
  readonly secret: boolean
  readonly args: unknown
  readonly confirmed: boolean
  readonly ok: boolean
  readonly error?: string | undefined
}

export interface ActResult {
  readonly ok: boolean
  readonly completed: number
  readonly error?: { readonly step: number; readonly message: string } | undefined
}

export interface ModelContextTool {
  readonly name: string
  readonly description: string
  readonly inputSchema?: object | undefined
  readonly annotations?: {
    readonly readOnlyHint?: boolean | undefined
    readonly consequentialHint?: boolean | undefined
  } | undefined
  readonly execute: (
    input: unknown,
    client?: { readonly signal?: AbortSignal | undefined }
  ) => Promise<unknown>
}

export interface ModelContext {
  readonly registerTool: (
    tool: ModelContextTool,
    options?: { readonly signal?: AbortSignal | undefined }
  ) => unknown
}

export interface Dispatcher {
  readonly dispatch: (instance: number, path: string, message: unknown) => Effect.Effect<boolean>
  readonly sync?: (() => void) | undefined
}

interface TrackedInstance {
  readonly instance: number
  readonly path: string
  readonly componentRef: unknown
  readonly component: string
  model: unknown
}

const scrubRedacted = (value: unknown): unknown => {
  if (Redacted.isRedacted(value)) return "[Redacted]"
  if (Array.isArray(value)) return value.map(scrubRedacted)
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) {
      out[k] = scrubRedacted(v)
    }
    return out
  }
  return value
}

const labelOf = (contract: AgentContract, model: unknown): string =>
  typeof contract.label === "function" ? contract.label(model) : contract.label

const jsonSchemaOf = (schema: Schema.Top): object => {
  const doc = Schema.toJsonSchemaDocument(schema)
  return doc.schema
}

export interface AgentBridge {
  readonly messageLog: MessageLog.MessageLog
  readonly registerControllable: (root: BrowserHost.Controllable) => () => void
  readonly attachDispatcher: (dispatcher: Dispatcher) => () => void
  readonly snapshot: () => ReadonlyArray<SnapshotEntry>
  readonly query: (filter: {
    readonly text?: string | undefined
    readonly component?: string | undefined
  }) => ReadonlyArray<SnapshotEntry>
  readonly act: (
    input: { readonly steps: ReadonlyArray<AgentStepInput> },
    options?: { readonly signal?: AbortSignal | undefined; readonly allow?: AllowCallback | undefined }
  ) => Effect.Effect<ActResult>
  readonly audit: () => ReadonlyArray<AuditEntry>
  readonly tools: (options?: {
    readonly prefix?: string | undefined
    readonly allow?: AllowCallback | undefined
  }) => ReadonlyArray<ModelContextTool>
  readonly registerWebMcp: (
    context: ModelContext,
    options: { readonly prefix?: string | undefined; readonly allow: AllowCallback }
  ) => Effect.Effect<void, never, Scope.Scope>
}

export class AgentBridgeService extends Context.Service<AgentBridgeService, AgentBridge>()(
  "effect-ui/AgentBridge"
) {}

export const make = (options: {
  readonly contracts: ReadonlyArray<AgentContract<any, any>>
  readonly allow?: AllowCallback | undefined
}): AgentBridge => {
  const byComponent = new Map<unknown, AgentContract>()
  for (const contract of options.contracts) {
    byComponent.set(contract.component, contract)
  }

  const instances = new Map<number, TrackedInstance>()
  const controllables = new Set<BrowserHost.Controllable>()
  const dispatchers = new Set<Dispatcher>()
  const auditLog: Array<AuditEntry> = []

  const messageLog: MessageLog.MessageLog = {
    enabled: true,
    record: (entry) => {
      if (entry._tag === "Mounted") {
        const contract = byComponent.get(entry.component)
        if (contract !== undefined) {
          const componentName = entry.path.split("/").pop()?.replace(/\[.*\]$/, "") || contract.componentName
          instances.set(entry.instance, {
            instance: entry.instance,
            path: entry.path,
            componentRef: entry.component,
            component: componentName,
            model: entry.model
          })
        }
      } else if (entry._tag === "Update") {
        const tracked = instances.get(entry.instance)
        if (tracked !== undefined) {
          tracked.model = entry.model
        }
      } else if (entry._tag === "Unmounted") {
        instances.delete(entry.instance)
      }
    }
  }

  const syncAll = () => {
    for (const dispatcher of dispatchers) {
      dispatcher.sync?.()
    }
  }

  const visibleEntries = (): ReadonlyArray<{
    readonly tracked: TrackedInstance
    readonly contract: AgentContract
    readonly label: string
  }> => {
    syncAll()
    const out: Array<{
      readonly tracked: TrackedInstance
      readonly contract: AgentContract
      readonly label: string
    }> = []
    for (const tracked of instances.values()) {
      const contract = byComponent.get(tracked.componentRef)
      if (contract === undefined) continue
      if (contract.hidden?.(tracked.model) === true) continue
      out.push({ tracked, contract, label: labelOf(contract, tracked.model) })
    }
    return out
  }

  const snapshot = (): ReadonlyArray<SnapshotEntry> =>
    visibleEntries().map(({ tracked, contract, label }) => {
      const actions: Array<SnapshotAction> = []
      for (const [name, spec] of Object.entries(contract.actions)) {
        if (spec.enabled && !spec.enabled(tracked.model)) continue
        const confirm =
          typeof spec.confirm === "string"
            ? spec.confirm
            : typeof spec.confirm === "function"
              ? spec.confirm(tracked.model, {})
              : undefined
        actions.push({
          name,
          description: spec.description,
          inputSchema: jsonSchemaOf(spec.args),
          ...(confirm !== undefined ? { confirm } : {}),
          ...(spec.secret === true ? { secret: true } : {})
        })
      }
      return {
        ref: tracked.path,
        instance: tracked.instance,
        component: tracked.component,
        label,
        state: scrubRedacted(contract.state(tracked.model)) as Record<string, unknown>,
        actions
      }
    })

  const query = (filter: {
    readonly text?: string | undefined
    readonly component?: string | undefined
  }): ReadonlyArray<SnapshotEntry> => {
    const needle = filter.text?.toLowerCase()
    return snapshot().filter((entry) => {
      if (filter.component !== undefined && entry.component !== filter.component) return false
      if (needle === undefined) return true
      if (entry.label.toLowerCase().includes(needle)) return true
      if (entry.ref.toLowerCase().includes(needle)) return true
      return entry.actions.some(
        (a) =>
          a.name.toLowerCase().includes(needle) ||
          a.description.toLowerCase().includes(needle)
      )
    })
  }

  const dispatchTo = (instance: number, path: string, message: unknown): Effect.Effect<boolean> =>
    Effect.gen(function*() {
      for (const root of controllables) {
        const controlled = root.instance(instance)
        if (controlled !== undefined) {
          const result = yield* controlled.dispatch(message)
          return result._tag === "Updated" || (result._tag === "Ignored" && result.reason === "unchanged")
        }
      }
      for (const dispatcher of dispatchers) {
        const ok = yield* dispatcher.dispatch(instance, path, message)
        if (ok) return true
      }
      return false
    })

  const act: AgentBridge["act"] = (input, callOptions) =>
    Effect.gen(function*() {
      const allow = callOptions?.allow ?? options.allow
      let completed = 0

      for (let i = 0; i < input.steps.length; i++) {
        const step = input.steps[i]!
        const visible = visibleEntries()
        const exact = visible.filter((v) => v.tracked.path === step.ref || v.label === step.ref)
        const matches =
          exact.length > 0
            ? exact
            : visible.filter((v) => v.label.toLowerCase().includes(step.ref.toLowerCase()))

        if (matches.length === 0) {
          return {
            ok: false,
            completed,
            error: { step: i, message: `No visible control matches ref "${step.ref}"` }
          }
        }
        if (matches.length > 1) {
          const refs = matches.map((m) => `${m.label} (${m.tracked.path})`).join(", ")
          return {
            ok: false,
            completed,
            error: { step: i, message: `Ambiguous ref "${step.ref}": matched ${refs}` }
          }
        }

        const { tracked, contract, label } = matches[0]!
        const actionSpec = contract.actions[step.action]
        if (actionSpec === undefined) {
          const allowed = Object.keys(contract.actions).join(", ")
          return {
            ok: false,
            completed,
            error: {
              step: i,
              message: `Unknown action "${step.action}" on "${label}". Allowed: ${allowed}`
            }
          }
        }

        if (actionSpec.enabled && !actionSpec.enabled(tracked.model)) {
          auditLog.push({
            ref: tracked.path,
            label,
            action: step.action,
            secret: actionSpec.secret === true,
            args: actionSpec.secret === true ? "[Redacted]" : scrubRedacted(step.args ?? {}),
            confirmed: false,
            ok: false,
            error: `Action "${step.action}" is currently disabled`
          })
          return {
            ok: false,
            completed,
            error: { step: i, message: `Action "${step.action}" is currently disabled` }
          }
        }

        const decoded = yield* Schema.decodeUnknownEffect(actionSpec.args)(step.args ?? {}, {
          onExcessProperty: "error"
        }).pipe(Effect.result)

        if (decoded._tag === "Failure") {
          const reason = `Invalid args for "${step.action}": ${String(decoded.failure)}`
          auditLog.push({
            ref: tracked.path,
            label,
            action: step.action,
            secret: actionSpec.secret === true,
            args: actionSpec.secret === true ? "[Redacted]" : scrubRedacted(step.args ?? {}),
            confirmed: false,
            ok: false,
            error: reason
          })
          return { ok: false, completed, error: { step: i, message: reason } }
        }

        const safeArgs = actionSpec.secret === true ? "[Redacted]" : scrubRedacted(decoded.success)

        const confirmText =
          typeof actionSpec.confirm === "function"
            ? actionSpec.confirm(tracked.model, decoded.success)
            : actionSpec.confirm

        let confirmed = false
        if (confirmText !== undefined) {
          if (allow === undefined) {
            const reason = `Needs a person: ${confirmText}`
            auditLog.push({
              ref: tracked.path,
              label,
              action: step.action,
              secret: actionSpec.secret === true,
              args: safeArgs,
              confirmed: false,
              ok: false,
              error: reason
            })
            return { ok: false, completed, error: { step: i, message: reason } }
          }
          const approved = yield* Effect.promise(() =>
            Promise.resolve(
              allow(
                {
                  ref: tracked.path,
                  label,
                  action: step.action,
                  confirm: confirmText,
                  args: safeArgs
                },
                { signal: callOptions?.signal }
              )
            )
          )
          if (!approved) {
            const reason = `Denied by person: ${confirmText}`
            auditLog.push({
              ref: tracked.path,
              label,
              action: step.action,
              secret: actionSpec.secret === true,
              args: safeArgs,
              confirmed: false,
              ok: false,
              error: reason
            })
            return { ok: false, completed, error: { step: i, message: reason } }
          }
          confirmed = true
        }

        const msg = actionSpec.toMessage(decoded.success, { source: "agent" })
        const dispatched = yield* dispatchTo(tracked.instance, tracked.path, msg)
        if (!dispatched) {
          const reason = `No mounted dispatcher accepted action "${step.action}" for "${tracked.path}"`
          auditLog.push({
            ref: tracked.path,
            label,
            action: step.action,
            secret: actionSpec.secret === true,
            args: safeArgs,
            confirmed,
            ok: false,
            error: reason
          })
          return { ok: false, completed, error: { step: i, message: reason } }
        }

        auditLog.push({
          ref: tracked.path,
          label,
          action: step.action,
          secret: actionSpec.secret === true,
          args: safeArgs,
          confirmed,
          ok: true
        })
        completed++
      }

      return { ok: true, completed }
    })

  const tools: AgentBridge["tools"] = (toolOptions) => {
    const prefix = toolOptions?.prefix ?? "ui_"
    const effectiveAllow = toolOptions?.allow ?? options.allow
    return [
      {
        name: `${prefix}snapshot`,
        description: "List visible interactive controls, their safe state, and their allowed actions with JSON Schemas.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: true },
        execute: async () => snapshot()
      },
      {
        name: `${prefix}query`,
        description: "Find visible controls by label, path, component name, or action name.",
        inputSchema: {
          type: "object",
          properties: {
            text: { type: "string" },
            component: { type: "string" }
          },
          additionalProperties: false
        },
        annotations: { readOnlyHint: true },
        execute: async (input) => {
          const q = (input ?? {}) as { text?: string; component?: string }
          return query({ text: q.text, component: q.component })
        }
      },
      {
        name: `${prefix}act`,
        description: "Run one or more typed actions on visible controls in order. Destructive actions require human confirmation.",
        inputSchema: {
          type: "object",
          properties: {
            steps: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  ref: { type: "string" },
                  action: { type: "string" },
                  args: { type: "object" }
                },
                required: ["ref", "action"],
                additionalProperties: false
              }
            }
          },
          required: ["steps"],
          additionalProperties: false
        },
        annotations: { consequentialHint: true },
        execute: async (input, client) => {
          const payload = (input ?? { steps: [] }) as { steps: ReadonlyArray<AgentStepInput> }
          return Effect.runPromise(
            act(payload, { signal: client?.signal, allow: effectiveAllow })
          )
        }
      }
    ]
  }

  const registerWebMcp: AgentBridge["registerWebMcp"] = (context, regOptions) =>
    Effect.acquireRelease(
      Effect.sync(() => {
        const controller = new AbortController()
        for (const tool of tools({ prefix: regOptions.prefix, allow: regOptions.allow })) {
          context.registerTool(tool, { signal: controller.signal })
        }
        return controller
      }),
      (controller) => Effect.sync(() => controller.abort())
    ).pipe(Effect.asVoid)

  return {
    messageLog,
    registerControllable: (root) => {
      controllables.add(root)
      return () => {
        controllables.delete(root)
      }
    },
    attachDispatcher: (dispatcher) => {
      dispatchers.add(dispatcher)
      return () => {
        dispatchers.delete(dispatcher)
      }
    },
    snapshot,
    query,
    act,
    audit: () => [...auditLog],
    tools,
    registerWebMcp
  }
}

export const attachTestRoot = <Model, Msg, Events>(
  bridge: AgentBridge,
  root: TestHost.Root<Model, Msg, Events>
): Effect.Effect<void, never, Scope.Scope | TestHost.TestHost> =>
  Effect.gen(function*() {
    const testHost = yield* TestHost.TestHost
    let seen = 0
    const sync = () => {
      const entries = root.log()
      while (seen < entries.length) {
        bridge.messageLog.record(entries[seen++]!)
      }
    }
    sync()
    yield* Effect.acquireRelease(
      Effect.sync(() =>
        bridge.attachDispatcher({
          sync,
          dispatch: (_instance, path, message) => {
            if (path !== root.path) return Effect.succeed(false)
            return Effect.sync(() => root.send(message as Msg)).pipe(
              Effect.andThen(TestHost.settle.pipe(Effect.orDie)),
              Effect.tap(() => Effect.sync(sync)),
              Effect.provideService(TestHost.TestHost, testHost),
              Effect.as(true)
            )
          }
        })
      ),
      (detach) => Effect.sync(detach)
    )
  })

export const layer = (options: {
  readonly contracts: ReadonlyArray<AgentContract<any, any>>
  readonly allow?: AllowCallback | undefined
}): Layer.Layer<AgentBridgeService> => {
  const bridge = make(options)
  return Layer.mergeAll(
    Layer.succeed(AgentBridgeService, bridge),
    Layer.effect(
      MessageLog.MessageLog,
      Effect.gen(function*() {
        const upstream = yield* MessageLog.MessageLog
        return upstream.enabled
          ? MessageLog.fanoutAll([upstream, bridge.messageLog])
          : bridge.messageLog
      })
    ),
    Layer.effect(
      BrowserHost.Controllables,
      Effect.gen(function*() {
        const upstream = yield* BrowserHost.Controllables
        return {
          register: (root: BrowserHost.Controllable) => {
            const unregisterUpstream = upstream.register(root)
            const unregisterBridge = bridge.registerControllable(root)
            return () => {
              unregisterBridge()
              unregisterUpstream()
            }
          }
        }
      })
    )
  )
}
