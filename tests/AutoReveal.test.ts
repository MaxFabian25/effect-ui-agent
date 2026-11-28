import type { Component, MessageLog } from "@effect/ui"
import { UiSchema } from "@effect/ui"
import { BrowserHost, Html } from "@effect/ui/html"
import { describe, expect, it } from "bun:test"
import { Data, Effect, Predicate, Redacted, Schema } from "effect"
import { GlobalWindow } from "happy-dom"
import * as AgentBridge from "../src/AgentBridge.js"
import { assertActionDiscoverable, assertActionNotDiscoverable } from "../src/testing.js"

const TestMessageLog = Data.taggedEnum<MessageLog.Mounted | MessageLog.Update | MessageLog.Unmounted>()
const TestSource = Data.taggedEnum<MessageLog.Source>()
const UnknownRecordSchema = Schema.Record(Schema.String, Schema.Unknown)
const decodeUnknownRecord = Schema.decodeUnknownSync(UnknownRecordSchema)

const readStringField = (value: unknown, key: string): string => {
  const record = decodeUnknownRecord(value)
  const field = record[key]
  if (typeof field !== "string") {
    throw new Error(`Expected string property "${key}"`)
  }
  return field
}

const readSnapshotLabels = (value: unknown): ReadonlyArray<string> => {
  if (!Array.isArray(value)) {
    throw new Error("Expected snapshot array")
  }
  return value.map((entry) => readStringField(entry, "label"))
}

let testSeq = 0
const mountEntry = (
  instance: number,
  path: string,
  component: Component.Any,
  model: unknown
): MessageLog.Mounted =>
  TestMessageLog.Mounted({
    seq: ++testSeq,
    at: 0,
    session: "test",
    instance,
    path,
    component,
    props: {},
    model,
    commands: [],
    events: [],
    adopted: false
  })

const updateEntry = (
  instance: number,
  path: string,
  component: Component.Any,
  model: unknown
): MessageLog.Update =>
  TestMessageLog.Update({
    seq: ++testSeq,
    at: 0,
    session: "test",
    instance,
    path,
    component,
    source: TestSource.Dispatch(),
    message: {},
    props: {},
    model,
    commands: [],
    events: [],
    lists: [],
    sends: []
  })

const unmountEntry = (
  instance: number,
  path: string,
  component: Component.Any
): MessageLog.Unmounted =>
  TestMessageLog.Unmounted({
    seq: ++testSeq,
    at: 0,
    session: "test",
    instance,
    path,
    component
  })

const withHappyDom = async <A>(fn: (win: GlobalWindow) => Promise<A>): Promise<A> => {
  const win = new GlobalWindow({ url: "http://localhost/" })
  const keys = [
    "window",
    "document",
    "DOMParser",
    "Node",
    "Element",
    "HTMLElement",
    "HTMLButtonElement",
    "HTMLInputElement",
    "HTMLDialogElement",
    "HTMLFormElement",
    "SVGElement",
    "Event",
    "CustomEvent",
    "KeyboardEvent",
    "MouseEvent",
    "FocusEvent",
    "MutationObserver",
    "ResizeObserver",
    "requestAnimationFrame",
    "cancelAnimationFrame",
    "getComputedStyle",
    "queueMicrotask"
  ] as const
  const prev: Record<string, unknown> = {}
  for (const k of keys) {
    prev[k] = globalThis[k]
  }
  Object.assign(globalThis, {
    window: win,
    document: win.document,
    DOMParser: win.DOMParser,
    Node: win.Node,
    Element: win.Element,
    HTMLElement: win.HTMLElement,
    HTMLButtonElement: win.HTMLButtonElement,
    HTMLInputElement: win.HTMLInputElement,
    HTMLDialogElement: win.HTMLDialogElement,
    HTMLFormElement: win.HTMLFormElement,
    SVGElement: win.SVGElement,
    Event: win.Event,
    CustomEvent: win.CustomEvent,
    KeyboardEvent: win.KeyboardEvent,
    MouseEvent: win.MouseEvent,
    FocusEvent: win.FocusEvent,
    MutationObserver: win.MutationObserver,
    ResizeObserver: win.ResizeObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    getComputedStyle: win.getComputedStyle.bind(win)
  })
  try {
    return await fn(win)
  } finally {
    Object.assign(globalThis, prev)
    await win.happyDOM.close()
  }
}

const nextFrame = () =>
  new Promise<void>((resolve) => {
    setTimeout(resolve, 25)
  })

const TabBarMsg = UiSchema.TaggedEnum({
  Select: { tab: Schema.Literals(["general", "security"]) }
})
const TabBarEvents = UiSchema.TaggedEnum({
  Selected: { tab: Schema.Literals(["general", "security"]) }
})
const TabBar = Html.component({
  name: "TabBar",
  props: Schema.Struct({ activeTab: Schema.Literals(["general", "security"]) }),
  model: Schema.Struct({ activeTab: Schema.Literals(["general", "security"]) }),
  message: TabBarMsg,
  events: TabBarEvents
}).make({
  init: ($) => ({ activeTab: $.props.activeTab }),
  update: {
    Select: ($, { tab }) => $.evolve({ activeTab: tab }).emit(TabBarEvents.Selected({ tab }))
  },
  view: (h, m) => h.div.children(m.activeTab)
})

const AccordionMsg = UiSchema.TaggedEnum({
  SetOpen: { open: Schema.Boolean }
})
const AccordionEvents = UiSchema.TaggedEnum({
  Toggled: { open: Schema.Boolean }
})
const AdvancedAccordion = Html.component({
  name: "AdvancedAccordion",
  props: Schema.Struct({ visible: Schema.Boolean, open: Schema.Boolean }),
  model: Schema.Struct({ open: Schema.Boolean }),
  message: AccordionMsg,
  events: AccordionEvents
}).make({
  init: ($) => ({ open: $.props.open }),
  update: {
    SetOpen: ($, { open }) => $.evolve({ open }).emit(AccordionEvents.Toggled({ open }))
  },
  view: (h, m) => h.div.children(String(m.open))
})

const WebhookMsg = UiSchema.TaggedEnum({
  SetUrl: { url: Schema.String }
})
const WebhookField = Html.component({
  name: "WebhookField",
  props: Schema.Struct({}),
  model: Schema.Struct({ url: Schema.String }),
  message: WebhookMsg
}).make({
  init: () => ({ url: "https://old.example" }),
  update: {
    SetUrl: ($, { url }) => $.evolve({ url })
  },
  view: (h, m) => h.div.children(m.url)
})

const PrivateControl = Html.component({
  name: "PrivateControl",
  props: Schema.Struct({}),
  model: Schema.Struct({ secretNote: Schema.String }),
  message: UiSchema.TaggedEnum({ Ping: {} })
}).make({
  init: () => ({ secretNote: "do-not-expose" }),
  update: { Ping: ($) => $.model },
  view: (h) => h.div
})

const ShellMsg = UiSchema.TaggedEnum({
  TabChanged: { tab: Schema.Literals(["general", "security"]) },
  AccordionChanged: { open: Schema.Boolean }
})
const SettingsShell = Html.component({
  name: "SettingsShell",
  props: Schema.Struct({}),
  model: Schema.Struct({
    activeTab: Schema.Literals(["general", "security"]),
    accordionOpen: Schema.Boolean
  }),
  message: ShellMsg
}).make({
  init: () => ({ activeTab: "general" as const, accordionOpen: false }),
  update: {
    TabChanged: ($, { tab }) => $.evolve({ activeTab: tab }),
    AccordionChanged: ($, { open }) => $.evolve({ accordionOpen: open })
  },
  view: (h, model) =>
    h.main.children(
      PrivateControl(h, { key: "private", props: {} }),
      TabBar(h, {
        key: "tabs",
        props: { activeTab: model.activeTab },
        onEmit: { Selected: ({ tab }) => ShellMsg.TabChanged({ tab }) }
      }),
      AdvancedAccordion(h, {
        key: "adv",
        props: { visible: model.activeTab === "security", open: model.accordionOpen },
        onEmit: { Toggled: ({ open }) => ShellMsg.AccordionChanged({ open }) }
      }),
      WebhookField(h, { key: "webhook", props: {} })
    )
})

const NoOpContainer = Html.component({
  name: "NoOpContainer",
  props: Schema.Struct({}),
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({ Open: {} })
}).make({
  init: () => ({}),
  update: { Open: ($) => $.model },
  view: (h) => h.div
})

const StuckTarget = Html.component({
  name: "StuckTarget",
  props: Schema.Struct({}),
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({ Go: {} })
}).make({
  init: () => ({}),
  update: { Go: ($) => $.model },
  view: (h) => h.div
})

const CycleA = Html.component({
  name: "CycleA",
  props: Schema.Struct({}),
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({ Open: {} })
}).make({
  init: () => ({}),
  update: { Open: ($) => $.model },
  view: (h) => h.div
})

const CycleB = Html.component({
  name: "CycleB",
  props: Schema.Struct({}),
  model: Schema.Struct({}),
  message: UiSchema.TaggedEnum({ Open: {} })
}).make({
  init: () => ({}),
  update: { Open: ($) => $.model },
  view: (h) => h.div
})

const EdgeShell = Html.component({
  name: "EdgeShell",
  props: Schema.Struct({}),
  model: Schema.Struct({}),
  message: Schema.Never
}).make({
  init: () => ({}),
  update: ($) => $.model,
  view: (h) =>
    h.div.children(
      NoOpContainer(h, { key: "noop", props: {} }),
      StuckTarget(h, { key: "stuck", props: {} }),
      CycleA(h, { key: "cycle-a", props: {} }),
      CycleB(h, { key: "cycle-b", props: {} })
    )
})

describe("Closed-container discovery and fail-closed auto-reveal", () => {
  it("discovers revealedBy controls with empty state, keeps plain hidden controls invisible, and auto-reveals nested Tab -> Accordion -> Field in one act()", async () => {
    await withHappyDom(async () => {
      const container = globalThis.document.createElement("div")
      globalThis.document.body.appendChild(container)

      let activeTab: "general" | "security" = "general"
      let accordionOpen = false

      const bridgeLayer = AgentBridge.layer({
        contracts: [
          AgentBridge.expose(PrivateControl, {
            label: "Private Control",
            hidden: () => true,
            state: (m) => ({ secretNote: m.secretNote }),
            actions: {
              ping: {
                description: "Ping",
                args: Schema.Struct({}),
                toMessage: () => ({ _tag: "Ping" as const })
              }
            }
          }),
          AgentBridge.expose(TabBar, {
            label: "Settings Tabs",
            state: (m) => {
              activeTab = m.activeTab
              return { activeTab: m.activeTab }
            },
            actions: {
              select: {
                description: "Switch active tab",
                args: Schema.Struct({ tab: Schema.Literals(["general", "security"]) }),
                toMessage: ({ tab }) => {
                  activeTab = tab
                  return TabBarMsg.Select({ tab })
                }
              }
            }
          }),
          AgentBridge.expose(AdvancedAccordion, {
            label: "Advanced Accordion",
            hidden: () => activeTab !== "security",
            revealedBy: {
              container: "Settings Tabs",
              action: "select",
              args: { tab: "security" },
              description: "Switch to Security tab"
            },
            state: (m) => {
              accordionOpen = m.open
              return { open: m.open }
            },
            actions: {
              expand: {
                description: "Expand advanced section",
                args: Schema.Struct({}),
                toMessage: () => {
                  accordionOpen = true
                  return AccordionMsg.SetOpen({ open: true })
                }
              }
            }
          }),
          AgentBridge.expose(WebhookField, {
            label: "Webhook URL",
            hidden: () => activeTab !== "security" || !accordionOpen,
            revealedBy: {
              container: "Advanced Accordion",
              action: "expand",
              description: "Expand Advanced Accordion"
            },
            state: (m) => ({ url: m.url }),
            actions: {
              setUrl: {
                description: "Update webhook URL",
                args: Schema.Struct({ url: Schema.String }),
                toMessage: ({ url }) => WebhookMsg.SetUrl({ url })
              }
            }
          })
        ]
      })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const bridge = yield* AgentBridge.AgentBridgeService
            yield* BrowserHost.mountEffect(SettingsShell, {}, container)
            yield* Effect.promise(nextFrame)

            // Discovery: Private Control is invisible; Webhook URL is discoverable with empty state
            const snap = bridge.snapshot()
            expect(snap.some((e) => e.label === "Private Control")).toBe(false)
            const hiddenWebhook = snap.find((e) => e.label === "Webhook URL")
            expect(hiddenWebhook?.hidden).toBe(true)
            expect(hiddenWebhook?.state).toEqual({})
            expect(hiddenWebhook?.revealedBy?.container).toBe("Advanced Accordion")
            expect(bridge.query({ text: "Webhook" }).length).toBe(1)
            expect(bridge.query({ text: "Webhook", includeHidden: false }).length).toBe(0)

            // One single act() targeting deeply nested hidden Webhook URL!
            const res = yield* bridge.act({
              steps: [{ ref: "Webhook URL", action: "setUrl", args: { url: "https://new.example" } }]
            })
            expect(res.ok).toBe(true)
            expect(res.completed).toBe(1)
            expect(res.revealed).toEqual([
              {
                container: "Settings Tabs",
                containerRef: "/SettingsShell/TabBar[tabs]",
                action: "select",
                target: "Advanced Accordion",
                targetRef: "/SettingsShell/AdvancedAccordion[adv]"
              },
              {
                container: "Advanced Accordion",
                containerRef: "/SettingsShell/AdvancedAccordion[adv]",
                action: "expand",
                target: "Webhook URL",
                targetRef: "/SettingsShell/WebhookField[webhook]"
              }
            ])
            expect(res.state.find((s) => s.label === "Webhook URL")?.state).toEqual({
              url: "https://new.example"
            })
            expect(bridge.audit().map((a) => `${a.label}:${a.action}`)).toEqual([
              "Settings Tabs:select",
              "Advanced Accordion:expand",
              "Webhook URL:setUrl"
            ])
          })
        ).pipe(Effect.provide(bridgeLayer))
      )
    })
  })

  it("fails closed when a reveal action does not unhide the target or when reveal refs form a cycle", async () => {
    await withHappyDom(async () => {
      const container = globalThis.document.createElement("div")
      globalThis.document.body.appendChild(container)

      const bridgeLayer = AgentBridge.layer({
        contracts: [
          AgentBridge.expose(NoOpContainer, {
            label: "Stuck Container",
            state: () => ({}),
            actions: {
              open: {
                description: "Open",
                args: Schema.Struct({}),
                toMessage: () => ({ _tag: "Open" as const })
              }
            }
          }),
          AgentBridge.expose(StuckTarget, {
            label: "Stuck Target",
            hidden: () => true,
            revealedBy: { container: "Stuck Container", action: "open" },
            state: () => ({}),
            actions: {
              go: {
                description: "Go",
                args: Schema.Struct({}),
                toMessage: () => ({ _tag: "Go" as const })
              }
            }
          }),
          AgentBridge.expose(CycleA, {
            label: "Cycle A",
            hidden: () => true,
            revealedBy: { container: "Cycle B", action: "open" },
            state: () => ({}),
            actions: {
              open: {
                description: "Open A",
                args: Schema.Struct({}),
                toMessage: () => ({ _tag: "Open" as const })
              }
            }
          }),
          AgentBridge.expose(CycleB, {
            label: "Cycle B",
            hidden: () => true,
            revealedBy: { container: "Cycle A", action: "open" },
            state: () => ({}),
            actions: {
              open: {
                description: "Open B",
                args: Schema.Struct({}),
                toMessage: () => ({ _tag: "Open" as const })
              }
            }
          })
        ]
      })

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function*() {
            const bridge = yield* AgentBridge.AgentBridgeService
            yield* BrowserHost.mountEffect(EdgeShell, {}, container)
            yield* Effect.promise(nextFrame)

            const stuckRes = yield* bridge.act({ steps: [{ ref: "Stuck Target", action: "go" }] })
            expect(stuckRes.ok).toBe(false)
            expect(stuckRes.error?.message).toContain("did not make")
            expect(stuckRes.revealed).toBeUndefined()

            const cycleRes = yield* bridge.act({ steps: [{ ref: "Cycle A", action: "open" }] })
            expect(cycleRes.ok).toBe(false)
            expect(cycleRes.error?.message).toContain("cycle")
            expect(cycleRes.revealed).toBeUndefined()
          })
        ).pipe(Effect.provide(bridgeLayer))
      )
    })
  })

  it("pre-validates action name, args schema, and missing allow before mutating closed containers", async () => {
    const ContainerComp = Html.component({
      name: "GateContainer",
      props: Schema.Struct({}),
      model: Schema.Struct({ open: Schema.Boolean }),
      message: UiSchema.TaggedEnum({ Open: {} })
    }).make({
      init: () => ({ open: false }),
      update: { Open: ($) => $.evolve({ open: true }) },
      view: (h) => h.div
    })

    const TargetComp = Html.component({
      name: "GateTarget",
      props: Schema.Struct({}),
      model: Schema.Struct({ secretLabel: Schema.String, ran: Schema.Boolean }),
      message: UiSchema.TaggedEnum({ Update: { url: Schema.String }, Delete: {} })
    }).make({
      init: () => ({ secretLabel: "top-secret-item", ran: false }),
      update: {
        Update: ($) => $.evolve({ ran: true }),
        Delete: ($) => $.evolve({ ran: true })
      },
      view: (h) => h.div
    })

    let openCount = 0
    let confirmEvalCount = 0
    let isOpen = false

    const bridge = AgentBridge.make({
      contracts: [
        AgentBridge.expose(ContainerComp, {
          label: "Gate Container",
          state: (m) => ({ open: m.open }),
          actions: {
            open: {
              description: "Open container",
              args: Schema.Struct({}),
              toMessage: () => ({ _tag: "Open" as const })
            }
          }
        }),
        AgentBridge.expose(TargetComp, {
          label: "Gate Target",
          hidden: () => !isOpen,
          revealedBy: { container: "Gate Container", action: "open" },
          state: (m) => ({ ran: m.ran }),
          actions: {
            update: {
              description: "Update URL",
              args: Schema.Struct({ url: Schema.String }),
              toMessage: ({ url }) => ({ _tag: "Update" as const, url })
            },
            deleteStatic: {
              description: "Delete with static confirm",
              args: Schema.Struct({}),
              confirm: "Really delete?",
              toMessage: () => ({ _tag: "Delete" as const })
            },
            deleteDynamic: {
              description: "Delete with dynamic confirm",
              args: Schema.Struct({}),
              confirm: (m) => {
                confirmEvalCount++
                return `Really delete ${m.secretLabel}?`
              },
              toMessage: () => ({ _tag: "Delete" as const })
            }
          }
        })
      ]
    })

    bridge.messageLog.record(mountEntry(1, "/App/GateContainer", ContainerComp, { open: false }))
    bridge.messageLog.record(
      mountEntry(2, "/App/GateTarget", TargetComp, { secretLabel: "top-secret-item", ran: false })
    )

    bridge.attachDispatcher({
      dispatch: (instance, _path, msg) =>
        Effect.sync(() => {
          if (instance === 1 && Predicate.isTagged(msg, "Open")) {
            openCount++
            isOpen = true
            bridge.messageLog.record(updateEntry(1, "/App/GateContainer", ContainerComp, { open: true }))
            return true
          }
          if (instance === 2) {
            bridge.messageLog.record(
              updateEntry(2, "/App/GateTarget", TargetComp, { secretLabel: "top-secret-item", ran: true })
            )
            return true
          }
          return false
        })
    })

    // 1. Unknown action fails BEFORE mutating container
    const badAction = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Gate Target", action: "nonexistent" }] })
    )
    expect(badAction.ok).toBe(false)
    expect(badAction.error?.message).toContain('Unknown action "nonexistent"')
    expect(badAction.revealed).toBeUndefined()
    expect(openCount).toBe(0)

    // 2. Invalid args fails BEFORE mutating container
    const badArgs = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Gate Target", action: "update", args: { url: 42 } }] })
    )
    expect(badArgs.ok).toBe(false)
    expect(badArgs.error?.message).toContain('Invalid args for "update"')
    expect(badArgs.revealed).toBeUndefined()
    expect(openCount).toBe(0)

    // 3. Static confirm without allow fails BEFORE mutating container
    const noAllowStatic = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Gate Target", action: "deleteStatic" }] })
    )
    expect(noAllowStatic.ok).toBe(false)
    expect(noAllowStatic.error?.message).toBe("Needs a person: Really delete?")
    expect(noAllowStatic.revealed).toBeUndefined()
    expect(openCount).toBe(0)

    // 4. Dynamic confirm without allow fails BEFORE mutating container and without evaluating hidden model
    const noAllowDynamic = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Gate Target", action: "deleteDynamic" }] })
    )
    expect(noAllowDynamic.ok).toBe(false)
    expect(noAllowDynamic.error?.message).toContain("Needs a person:")
    expect(noAllowDynamic.error?.message).not.toContain("top-secret-item")
    expect(noAllowDynamic.revealed).toBeUndefined()
    expect(confirmEvalCount).toBe(0)
    expect(openCount).toBe(0)

    // 5. Dynamic confirm WITH allow reveals container first and evaluates confirm on post-reveal state
    const prompts: Array<string> = []
    const withAllow = await Effect.runPromise(
      bridge.act(
        { steps: [{ ref: "Gate Target", action: "deleteDynamic" }] },
        {
          allow: (req) => {
            prompts.push(req.confirm)
            return true
          }
        }
      )
    )
    expect(withAllow.ok).toBe(true)
    expect(openCount).toBe(1)
    expect(prompts).toEqual(["Really delete top-secret-item?"])
    expect(withAllow.revealed).toEqual([
      {
        container: "Gate Container",
        containerRef: "/App/GateContainer",
        action: "open",
        target: "Gate Target",
        targetRef: "/App/GateTarget"
      }
    ])
  })

  it("supports targets that remount with a new instance ID at the same path after container reveal", async () => {
    const DialogComp = Html.component({
      name: "RemountDialog",
      props: Schema.Struct({}),
      model: Schema.Struct({ open: Schema.Boolean }),
      message: UiSchema.TaggedEnum({ Open: {} })
    }).make({
      init: () => ({ open: false }),
      update: { Open: ($) => $.evolve({ open: true }) },
      view: (h) => h.div
    })

    const FieldComp = Html.component({
      name: "RemountField",
      props: Schema.Struct({}),
      model: Schema.Struct({ visible: Schema.Boolean, value: Schema.String }),
      message: UiSchema.TaggedEnum({ Set: { value: Schema.String } })
    }).make({
      init: () => ({ visible: false, value: "" }),
      update: { Set: ($, { value }) => $.evolve({ value }) },
      view: (h) => h.div
    })

    const bridge = AgentBridge.make({
      contracts: [
        AgentBridge.expose(DialogComp, {
          label: "Remount Dialog",
          state: (m) => ({ open: m.open }),
          actions: {
            open: {
              description: "Open dialog",
              args: Schema.Struct({}),
              toMessage: () => ({ _tag: "Open" as const })
            }
          }
        }),
        AgentBridge.expose(FieldComp, {
          label: "Remount Field",
          hidden: (m) => !m.visible,
          revealedBy: { container: "Remount Dialog", action: "open" },
          state: (m) => ({ value: m.value }),
          actions: {
            set: {
              description: "Set value",
              args: Schema.Struct({ value: Schema.String }),
              toMessage: ({ value }) => ({ _tag: "Set" as const, value })
            }
          }
        })
      ]
    })

    bridge.messageLog.record(mountEntry(10, "/App/RemountDialog", DialogComp, { open: false }))
    bridge.messageLog.record(mountEntry(20, "/App/RemountField", FieldComp, { visible: false, value: "" }))

    const dispatchedInstances: Array<number> = []
    bridge.attachDispatcher({
      dispatch: (instance, _path, msg) =>
        Effect.sync(() => {
          dispatchedInstances.push(instance)
          if (instance === 10 && Predicate.isTagged(msg, "Open")) {
            bridge.messageLog.record(updateEntry(10, "/App/RemountDialog", DialogComp, { open: true }))
            // Remount child with brand-new instance ID 99 at the same path
            bridge.messageLog.record(unmountEntry(20, "/App/RemountField", FieldComp))
            bridge.messageLog.record(
              mountEntry(99, "/App/RemountField", FieldComp, { visible: true, value: "" })
            )
            return true
          }
          if (instance === 99 && Predicate.isTagged(msg, "Set")) {
            bridge.messageLog.record(
              updateEntry(99, "/App/RemountField", FieldComp, {
                visible: true,
                value: readStringField(msg, "value")
              })
            )
            return true
          }
          return false
        })
    })

    const res = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Remount Field", action: "set", args: { value: "remounted!" } }] })
    )
    expect(res.ok).toBe(true)
    expect(dispatchedInstances).toEqual([10, 99])
    expect(res.revealed).toEqual([
      {
        container: "Remount Dialog",
        containerRef: "/App/RemountDialog",
        action: "open",
        target: "Remount Field",
        targetRef: "/App/RemountField"
      }
    ])
    expect(res.state.find((s) => s.label === "Remount Field")?.state).toEqual({ value: "remounted!" })
  })

  it("does not leak hidden model state in snapshot() and preserves raw Redacted values in revealedBy.args", async () => {
    const VaultComp = Html.component({
      name: "VaultContainer",
      props: Schema.Struct({}),
      model: Schema.Struct({ unlocked: Schema.Boolean }),
      message: UiSchema.TaggedEnum({
        Unlock: { token: Schema.Redacted(Schema.String) },
        UnlockSecret: { passphrase: Schema.Redacted(Schema.String) }
      })
    }).make({
      init: () => ({ unlocked: false }),
      update: {
        Unlock: ($) => $.evolve({ unlocked: true }),
        UnlockSecret: ($) => $.evolve({ unlocked: true })
      },
      view: (h) => h.div
    })

    const SecretItemComp = Html.component({
      name: "SecretItem",
      props: Schema.Struct({}),
      model: Schema.Struct({ leakedName: Schema.String, enabledFlag: Schema.Boolean }),
      message: UiSchema.TaggedEnum({ Destroy: {} })
    }).make({
      init: () => ({ leakedName: "SUPER-SECRET-RECORD", enabledFlag: false }),
      update: { Destroy: ($) => $.model },
      view: (h) => h.div
    })

    const SecretActionChildComp = Html.component({
      name: "SecretActionChild",
      props: Schema.Struct({}),
      model: Schema.Struct({}),
      message: UiSchema.TaggedEnum({ Ping: {} })
    }).make({
      init: () => ({}),
      update: { Ping: ($) => $.model },
      view: (h) => h.div
    })

    let hiddenConfirmCalled = false
    let hiddenEnabledCalled = false
    let unlocked = false
    let receivedTokenValue: string | undefined

    const bridge = AgentBridge.make({
      contracts: [
        AgentBridge.expose(VaultComp, {
          label: "Vault",
          state: (m) => ({ unlocked: m.unlocked }),
          actions: {
            unlock: {
              description: "Unlock with Redacted token",
              args: Schema.Struct({ token: Schema.Redacted(Schema.String) }),
              toMessage: ({ token }) => {
                receivedTokenValue = Redacted.value(token)
                return { _tag: "Unlock" as const, token }
              }
            },
            unlockSecret: {
              description: "Unlock with secret passphrase",
              secret: true,
              args: Schema.Struct({ passphrase: Schema.RedactedFromValue(Schema.String) }),
              toMessage: ({ passphrase }) => ({ _tag: "UnlockSecret" as const, passphrase })
            }
          }
        }),
        AgentBridge.expose(SecretItemComp, {
          label: "Secret Item",
          hidden: () => !unlocked,
          revealedBy: {
            container: "Vault",
            action: "unlock",
            args: { token: Redacted.make("raw-redacted-token-999") }
          },
          state: (m) => ({ leakedName: m.leakedName }),
          actions: {
            destroy: {
              description: "Destroy secret item",
              args: Schema.Struct({}),
              enabled: (m) => {
                hiddenEnabledCalled = true
                return m.enabledFlag
              },
              confirm: (m) => {
                hiddenConfirmCalled = true
                return `Destroy ${m.leakedName}?`
              },
              toMessage: () => ({ _tag: "Destroy" as const })
            }
          }
        }),
        AgentBridge.expose(SecretActionChildComp, {
          label: "Secret Action Child",
          hidden: () => !unlocked,
          revealedBy: {
            container: "Vault",
            action: "unlockSecret",
            args: { passphrase: "plain-secret-passphrase" }
          },
          state: () => ({}),
          actions: {
            ping: {
              description: "Ping",
              args: Schema.Struct({}),
              toMessage: () => ({ _tag: "Ping" as const })
            }
          }
        })
      ]
    })

    bridge.messageLog.record(mountEntry(1, "/App/Vault", VaultComp, { unlocked: false }))
    bridge.messageLog.record(
      mountEntry(2, "/App/SecretItem", SecretItemComp, { leakedName: "SUPER-SECRET-RECORD", enabledFlag: false })
    )
    bridge.messageLog.record(mountEntry(3, "/App/SecretActionChild", SecretActionChildComp, {}))

    bridge.attachDispatcher({
      dispatch: (instance, _path, msg) =>
        Effect.sync(() => {
          if (instance === 1 && Predicate.isTagged(msg, "Unlock")) {
            unlocked = true
            bridge.messageLog.record(updateEntry(1, "/App/Vault", VaultComp, { unlocked: true }))
            bridge.messageLog.record(
              updateEntry(2, "/App/SecretItem", SecretItemComp, {
                leakedName: "SUPER-SECRET-RECORD",
                enabledFlag: true
              })
            )
            return true
          }
          if (instance === 2) return true
          return false
        })
    })

    // snapshot() must NOT invoke dynamic confirm(model) or enabled(model) on hidden entries,
    // and must scrub Redacted args AND omit args for secret: true container reveal actions.
    const snap = bridge.snapshot()
    expect(hiddenConfirmCalled).toBe(false)
    expect(hiddenEnabledCalled).toBe(false)
    expect(JSON.stringify(snap)).not.toContain("SUPER-SECRET-RECORD")
    expect(JSON.stringify(snap)).not.toContain("raw-redacted-token-999")
    expect(JSON.stringify(snap)).not.toContain("plain-secret-passphrase")

    const secretItemSnap = snap.find((e) => e.label === "Secret Item")
    expect(secretItemSnap?.hidden).toBe(true)
    expect(secretItemSnap?.actions).toHaveLength(1)
    expect(secretItemSnap?.actions[0]?.confirm).toBe("Confirmation required after reveal")
    expect(secretItemSnap?.revealedBy?.args).toEqual({ token: "[Redacted]" })

    const secretChildSnap = snap.find((e) => e.label === "Secret Action Child")
    expect(secretChildSnap?.revealedBy?.args).toBeUndefined()

    // act() passes the raw Redacted token intact to Vault's unlock action!
    const actRes = await Effect.runPromise(
      bridge.act(
        { steps: [{ ref: "Secret Item", action: "destroy" }] },
        { allow: () => true }
      )
    )
    expect(actRes.ok).toBe(true)
    expect(receivedTokenValue).toBe("raw-redacted-token-999")
    expect(JSON.stringify(bridge.audit())).not.toContain("raw-redacted-token-999")
  })

  it("rejects self-reference cycle (A -> A) and auto-reveal depth > 4 cleanly", async () => {
    const makeNode = (name: string) =>
      Html.component({
        name,
        props: Schema.Struct({}),
        model: Schema.Struct({}),
        message: UiSchema.TaggedEnum({ Open: {} })
      }).make({
        init: () => ({}),
        update: { Open: ($) => $.model },
        view: (h) => h.div
      })

    const SelfCycle = makeNode("SelfCycle")
    const Level0 = makeNode("Level0")
    const Level1 = makeNode("Level1")
    const Level2 = makeNode("Level2")
    const Level3 = makeNode("Level3")
    const Level4 = makeNode("Level4")
    const Level5 = makeNode("Level5")

    const bridge = AgentBridge.make({
      contracts: [
        AgentBridge.expose(SelfCycle, {
          label: "Self Cycle",
          hidden: () => true,
          revealedBy: { container: "Self Cycle", action: "open" },
          state: () => ({}),
          actions: {
            open: { description: "Open", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
          }
        }),
        AgentBridge.expose(Level0, {
          label: "Level 0",
          state: () => ({}),
          actions: {
            open: { description: "Open", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
          }
        }),
        AgentBridge.expose(Level1, {
          label: "Level 1",
          hidden: () => true,
          revealedBy: { container: "Level 0", action: "open" },
          state: () => ({}),
          actions: {
            open: { description: "Open", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
          }
        }),
        AgentBridge.expose(Level2, {
          label: "Level 2",
          hidden: () => true,
          revealedBy: { container: "Level 1", action: "open" },
          state: () => ({}),
          actions: {
            open: { description: "Open", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
          }
        }),
        AgentBridge.expose(Level3, {
          label: "Level 3",
          hidden: () => true,
          revealedBy: { container: "Level 2", action: "open" },
          state: () => ({}),
          actions: {
            open: { description: "Open", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
          }
        }),
        AgentBridge.expose(Level4, {
          label: "Level 4",
          hidden: () => true,
          revealedBy: { container: "Level 3", action: "open" },
          state: () => ({}),
          actions: {
            open: { description: "Open", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
          }
        }),
        AgentBridge.expose(Level5, {
          label: "Level 5",
          hidden: () => true,
          revealedBy: { container: "Level 4", action: "open" },
          state: () => ({}),
          actions: {
            open: { description: "Open", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
          }
        })
      ]
    })

    const nodes = [
      [1, "/App/SelfCycle", SelfCycle],
      [2, "/App/Level0", Level0],
      [3, "/App/Level1", Level1],
      [4, "/App/Level2", Level2],
      [5, "/App/Level3", Level3],
      [6, "/App/Level4", Level4],
      [7, "/App/Level5", Level5]
    ] as const
    for (const [instance, path, component] of nodes) {
      bridge.messageLog.record(mountEntry(instance, path, component, {}))
    }

    const selfRes = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Self Cycle", action: "open" }] })
    )
    expect(selfRes.ok).toBe(false)
    expect(selfRes.error?.message).toContain("cycle")

    const deepRes = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Level 5", action: "open" }] })
    )
    expect(deepRes.ok).toBe(false)
    expect(deepRes.error?.message).toContain("Exceeded maximum auto-reveal depth (4)")
  })

  it("fails closed without crashing when allow, toMessage, revealedBy, hidden, or dispatchTo throws", async () => {
    const FaultyComp = Html.component({
      name: "FaultyComp",
      props: Schema.Struct({}),
      model: Schema.Struct({}),
      message: UiSchema.TaggedEnum({ Go: {} })
    }).make({
      init: () => ({}),
      update: { Go: ($) => $.model },
      view: (h) => h.div
    })

    const BadRevealComp = Html.component({
      name: "BadRevealComp",
      props: Schema.Struct({}),
      model: Schema.Struct({}),
      message: UiSchema.TaggedEnum({ Go: {} })
    }).make({
      init: () => ({}),
      update: { Go: ($) => $.model },
      view: (h) => h.div
    })

    const BadHiddenComp = Html.component({
      name: "BadHiddenComp",
      props: Schema.Struct({}),
      model: Schema.Struct({}),
      message: UiSchema.TaggedEnum({ Go: {} })
    }).make({
      init: () => ({}),
      update: { Go: ($) => $.model },
      view: (h) => h.div
    })

    const bridge = AgentBridge.make({
      contracts: [
        AgentBridge.expose(FaultyComp, {
          label: "Faulty Control",
          state: () => ({}),
          actions: {
            needsConfirm: {
              description: "Needs confirm",
              args: Schema.Struct({}),
              confirm: "Proceed?",
              toMessage: () => ({ _tag: "Go" as const })
            },
            badToMessage: {
              description: "Throws in toMessage",
              args: Schema.Struct({}),
              toMessage: () => {
                throw new Error("boom in toMessage")
              }
            },
            badDispatch: {
              description: "Throws in dispatcher",
              args: Schema.Struct({}),
              toMessage: () => ({ _tag: "Go" as const })
            }
          }
        }),
        AgentBridge.expose(BadRevealComp, {
          label: "Bad Reveal",
          hidden: () => true,
          revealedBy: () => {
            throw new Error("boom in revealedBy")
          },
          state: () => ({}),
          actions: {
            go: { description: "Go", args: Schema.Struct({}), toMessage: () => ({ _tag: "Go" as const }) }
          }
        }),
        AgentBridge.expose(BadHiddenComp, {
          label: "Bad Hidden",
          hidden: () => {
            throw new Error("boom in hidden")
          },
          state: () => ({}),
          actions: {
            go: { description: "Go", args: Schema.Struct({}), toMessage: () => ({ _tag: "Go" as const }) }
          }
        })
      ]
    })

    bridge.messageLog.record(mountEntry(1, "/App/Faulty", FaultyComp, {}))
    bridge.messageLog.record(mountEntry(2, "/App/BadReveal", BadRevealComp, {}))
    bridge.messageLog.record(mountEntry(3, "/App/BadHidden", BadHiddenComp, {}))

    bridge.attachDispatcher({
      dispatch: () => Effect.die(new Error("dispatcher exploded"))
    })

    // snapshot() must not crash and excludes throwing hidden/revealedBy controls
    const snap = bridge.snapshot()
    expect(snap.map((e) => e.label)).toEqual(["Faulty Control"])

    // Throwing allow (sync and async rejection) fails closed with "Confirmation handler failed" + audit entry
    const syncThrowAllow = await Effect.runPromise(
      bridge.act(
        { steps: [{ ref: "Faulty Control", action: "needsConfirm" }] },
        {
          allow: () => {
            throw new Error("sync allow boom")
          }
        }
      )
    )
    expect(syncThrowAllow.ok).toBe(false)
    expect(syncThrowAllow.error?.message).toBe("Confirmation handler failed")
    expect(bridge.audit().at(-1)).toMatchObject({
      action: "needsConfirm",
      ok: false,
      error: "Confirmation handler failed"
    })

    const asyncRejectAllow = await Effect.runPromise(
      bridge.act(
        { steps: [{ ref: "Faulty Control", action: "needsConfirm" }] },
        { allow: async () => Promise.reject(new Error("async allow boom")) }
      )
    )
    expect(asyncRejectAllow.ok).toBe(false)
    expect(asyncRejectAllow.error?.message).toBe("Confirmation handler failed")

    // Throwing toMessage fails closed + audit entry
    const badMsgRes = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Faulty Control", action: "badToMessage" }] })
    )
    expect(badMsgRes.ok).toBe(false)
    expect(badMsgRes.error?.message).toContain("failed to build message")
    expect(bridge.audit().at(-1)).toMatchObject({
      action: "badToMessage",
      ok: false
    })

    // Throwing dispatcher fails closed + audit entry
    const badDispatchRes = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Faulty Control", action: "badDispatch" }] })
    )
    expect(badDispatchRes.ok).toBe(false)
    expect(badDispatchRes.error?.message).toContain("Dispatch failed")
    expect(bridge.audit().at(-1)).toMatchObject({
      action: "badDispatch",
      ok: false
    })

    // Throwing revealedBy fails closed + audit entry
    const badRevealRes = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Bad Reveal", action: "go" }] })
    )
    expect(badRevealRes.ok).toBe(false)
    expect(badRevealRes.error?.message).toContain("Failed to resolve reveal metadata")
    expect(bridge.audit().at(-1)).toMatchObject({
      label: "Bad Reveal",
      action: "go",
      ok: false
    })

    // Throwing hidden is excluded (fails closed)
    const badHiddenRes = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Bad Hidden", action: "go" }] })
    )
    expect(badHiddenRes.ok).toBe(false)
    expect(badHiddenRes.error?.message).toContain("No visible control")
  })

  it("prefers exact hidden ref over substring visible match", async () => {
    const VisibleSettings = Html.component({
      name: "VisibleSettings",
      props: Schema.Struct({}),
      model: Schema.Struct({ open: Schema.Boolean }),
      message: UiSchema.TaggedEnum({ Open: {} })
    }).make({
      init: () => ({ open: false }),
      update: { Open: ($) => $.evolve({ open: true }) },
      view: (h) => h.div
    })

    const ExactHidden = Html.component({
      name: "ExactHidden",
      props: Schema.Struct({}),
      model: Schema.Struct({ url: Schema.String }),
      message: UiSchema.TaggedEnum({ SetUrl: { url: Schema.String } })
    }).make({
      init: () => ({ url: "" }),
      update: { SetUrl: ($, { url }) => $.evolve({ url }) },
      view: (h) => h.div
    })

    let isOpen = false
    const bridge = AgentBridge.make({
      contracts: [
        AgentBridge.expose(VisibleSettings, {
          label: "Webhook URL Settings",
          state: (m) => ({ open: m.open }),
          actions: {
            open: {
              description: "Open settings",
              args: Schema.Struct({}),
              toMessage: () => ({ _tag: "Open" as const })
            }
          }
        }),
        AgentBridge.expose(ExactHidden, {
          label: "Webhook URL",
          hidden: () => !isOpen,
          revealedBy: { container: "Webhook URL Settings", action: "open" },
          state: (m) => ({ url: m.url }),
          actions: {
            setUrl: {
              description: "Set webhook URL",
              args: Schema.Struct({ url: Schema.String }),
              toMessage: ({ url }) => ({ _tag: "SetUrl" as const, url })
            }
          }
        })
      ]
    })

    bridge.messageLog.record(mountEntry(1, "/App/WebhookSettings", VisibleSettings, { open: false }))
    bridge.messageLog.record(mountEntry(2, "/App/WebhookField", ExactHidden, { url: "" }))

    bridge.attachDispatcher({
      dispatch: (instance, _path, msg) =>
        Effect.sync(() => {
          if (instance === 1 && Predicate.isTagged(msg, "Open")) {
            isOpen = true
            bridge.messageLog.record(updateEntry(1, "/App/WebhookSettings", VisibleSettings, { open: true }))
            return true
          }
          if (instance === 2 && Predicate.isTagged(msg, "SetUrl")) {
            bridge.messageLog.record(
              updateEntry(2, "/App/WebhookField", ExactHidden, { url: readStringField(msg, "url") })
            )
            return true
          }
          return false
        })
    })

    const res = await Effect.runPromise(
      bridge.act({ steps: [{ ref: "Webhook URL", action: "setUrl", args: { url: "https://exact.example" } }] })
    )
    expect(res.ok).toBe(true)
    expect(res.revealed).toEqual([
      {
        container: "Webhook URL Settings",
        containerRef: "/App/WebhookSettings",
        action: "open",
        target: "Webhook URL",
        targetRef: "/App/WebhookField"
      }
    ])
    expect(res.state.find((s) => s.label === "Webhook URL")?.state).toEqual({ url: "https://exact.example" })
  })

  it("supports includeHidden in WebMCP ui_snapshot, defaults testing assertions to includeHidden: false, and deduplicates syncAll() in snapshot()", async () => {
    const ContainerComp = Html.component({
      name: "SnapContainer",
      props: Schema.Struct({}),
      model: Schema.Struct({}),
      message: UiSchema.TaggedEnum({ Open: {} })
    }).make({
      init: () => ({}),
      update: { Open: ($) => $.model },
      view: (h) => h.div
    })

    const HiddenComp = Html.component({
      name: "SnapHidden",
      props: Schema.Struct({}),
      model: Schema.Struct({}),
      message: UiSchema.TaggedEnum({ Edit: {} })
    }).make({
      init: () => ({}),
      update: { Edit: ($) => $.model },
      view: (h) => h.div
    })

    const bridge = AgentBridge.make({
      contracts: [
        AgentBridge.expose(ContainerComp, {
          label: "Snap Container",
          state: () => ({}),
          actions: {
            open: { description: "Open", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
          }
        }),
        AgentBridge.expose(HiddenComp, {
          label: "Snap Hidden",
          hidden: () => true,
          revealedBy: { container: "Snap Container", action: "open" },
          state: () => ({}),
          actions: {
            edit: { description: "Edit", args: Schema.Struct({}), toMessage: () => ({ _tag: "Edit" as const }) }
          }
        })
      ]
    })

    bridge.messageLog.record(mountEntry(1, "/App/SnapContainer", ContainerComp, {}))
    bridge.messageLog.record(mountEntry(2, "/App/SnapHidden", HiddenComp, {}))

    let syncCalls = 0
    bridge.attachDispatcher({
      sync: () => {
        syncCalls++
      },
      dispatch: () => Effect.succeed(false)
    })

    // Deduplicated syncAll(): single snapshot() invokes sync() exactly once
    const fullSnap = bridge.snapshot()
    expect(fullSnap.map((e) => e.label)).toEqual(["Snap Container", "Snap Hidden"])
    expect(syncCalls).toBe(1)

    // WebMCP ui_snapshot accepts includeHidden
    const snapshotTool = bridge.tools().find((t) => t.name === "ui_snapshot")
    if (snapshotTool === undefined) throw new Error("Expected ui_snapshot tool")
    expect(snapshotTool.inputSchema).toMatchObject({
      type: "object",
      properties: { includeHidden: { type: "boolean" } },
      additionalProperties: false
    })
    const webMcpDefault = readSnapshotLabels(await snapshotTool.execute({}))
    expect(webMcpDefault).toEqual(["Snap Container", "Snap Hidden"])
    const webMcpVisibleOnly = readSnapshotLabels(await snapshotTool.execute({ includeHidden: false }))
    expect(webMcpVisibleOnly).toEqual(["Snap Container"])

    // Testing helpers default to includeHidden: false and allow opting in with includeHidden: true
    assertActionDiscoverable(bridge, { label: "Snap Container", action: "open" })
    assertActionNotDiscoverable(bridge, { label: "Snap Hidden", action: "edit" })
    assertActionDiscoverable(bridge, { label: "Snap Hidden", action: "edit", includeHidden: true })
    expect(() => assertActionNotDiscoverable(bridge, { label: "Snap Hidden", action: "edit", includeHidden: true }))
      .toThrow(/^Unexpected exposure:/)
  })

  it("re-resolves dynamic revealedBy and short-circuits inner reveals when an outer reveal already unhides the target", async () => {
    const OuterComp = Html.component({
      name: "OuterComp",
      props: Schema.Struct({}),
      model: Schema.Struct({ open: Schema.Boolean }),
      message: UiSchema.TaggedEnum({ Open: {} })
    }).make({
      init: () => ({ open: false }),
      update: { Open: ($) => $.evolve({ open: true }) },
      view: (h) => h.div
    })

    const InnerComp = Html.component({
      name: "InnerComp",
      props: Schema.Struct({}),
      model: Schema.Struct({ section: Schema.String }),
      message: UiSchema.TaggedEnum({ Expand: { section: Schema.String } })
    }).make({
      init: () => ({ section: "initial" }),
      update: { Expand: ($, { section }) => $.evolve({ section }) },
      view: (h) => h.div
    })

    const LeafComp = Html.component({
      name: "LeafComp",
      props: Schema.Struct({}),
      model: Schema.Struct({ dynamicSection: Schema.String, done: Schema.Boolean }),
      message: UiSchema.TaggedEnum({ Run: {} })
    }).make({
      init: () => ({ dynamicSection: "stale", done: false }),
      update: { Run: ($) => $.evolve({ done: true }) },
      view: (h) => h.div
    })

    // Case 1: Outer reveal updates Leaf's model so dynamic revealedBy.args re-resolves to "fresh"
    {
      let outerOpen = false
      let innerExpandedWith: string | undefined

      const bridge = AgentBridge.make({
        contracts: [
          AgentBridge.expose(OuterComp, {
            label: "Outer",
            state: (m) => ({ open: m.open }),
            actions: {
              open: { description: "Open outer", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
            }
          }),
          AgentBridge.expose(InnerComp, {
            label: "Inner",
            hidden: () => !outerOpen,
            revealedBy: { container: "Outer", action: "open" },
            state: (m) => ({ section: m.section }),
            actions: {
              expand: {
                description: "Expand section",
                args: Schema.Struct({ section: Schema.String }),
                toMessage: ({ section }) => ({ _tag: "Expand" as const, section })
              }
            }
          }),
          AgentBridge.expose(LeafComp, {
            label: "Leaf",
            hidden: () => !outerOpen || innerExpandedWith !== "fresh",
            revealedBy: (m) => ({
              container: "Inner",
              action: "expand",
              args: { section: m.dynamicSection }
            }),
            state: (m) => ({ done: m.done }),
            actions: {
              run: { description: "Run", args: Schema.Struct({}), toMessage: () => ({ _tag: "Run" as const }) }
            }
          })
        ]
      })

      bridge.messageLog.record(mountEntry(1, "/App/Outer", OuterComp, { open: false }))
      bridge.messageLog.record(mountEntry(2, "/App/Inner", InnerComp, { section: "initial" }))
      bridge.messageLog.record(mountEntry(3, "/App/Leaf", LeafComp, { dynamicSection: "stale", done: false }))

      bridge.attachDispatcher({
        dispatch: (instance, _path, msg) =>
          Effect.sync(() => {
            if (instance === 1) {
              outerOpen = true
              bridge.messageLog.record(updateEntry(1, "/App/Outer", OuterComp, { open: true }))
              // Opening Outer updates Leaf's model so its dynamic revealedBy now points to section: "fresh"
              bridge.messageLog.record(updateEntry(3, "/App/Leaf", LeafComp, { dynamicSection: "fresh", done: false }))
              return true
            }
            if (instance === 2) {
              innerExpandedWith = readStringField(msg, "section")
              bridge.messageLog.record(updateEntry(2, "/App/Inner", InnerComp, { section: innerExpandedWith }))
              return true
            }
            if (instance === 3) {
              bridge.messageLog.record(updateEntry(3, "/App/Leaf", LeafComp, { dynamicSection: "fresh", done: true }))
              return true
            }
            return false
          })
      })

      const res = await Effect.runPromise(bridge.act({ steps: [{ ref: "Leaf", action: "run" }] }))
      expect(res.ok).toBe(true)
      expect(innerExpandedWith).toBe("fresh")
      expect(res.revealed).toHaveLength(2)
    }

    // Case 2: Outer reveal ALREADY makes Leaf visible -> short-circuits without running Inner.expand
    {
      let outerOpen = false
      let innerExpandCalls = 0

      const bridge = AgentBridge.make({
        contracts: [
          AgentBridge.expose(OuterComp, {
            label: "Outer",
            state: (m) => ({ open: m.open }),
            actions: {
              open: { description: "Open outer", args: Schema.Struct({}), toMessage: () => ({ _tag: "Open" as const }) }
            }
          }),
          AgentBridge.expose(InnerComp, {
            label: "Inner",
            hidden: () => !outerOpen,
            revealedBy: { container: "Outer", action: "open" },
            state: (m) => ({ section: m.section }),
            actions: {
              expand: {
                description: "Expand section",
                args: Schema.Struct({ section: Schema.String }),
                toMessage: ({ section }) => ({ _tag: "Expand" as const, section })
              }
            }
          }),
          AgentBridge.expose(LeafComp, {
            label: "Leaf",
            hidden: () => !outerOpen,
            revealedBy: { container: "Inner", action: "expand", args: { section: "already-open" } },
            state: (m) => ({ done: m.done }),
            actions: {
              run: { description: "Run", args: Schema.Struct({}), toMessage: () => ({ _tag: "Run" as const }) }
            }
          })
        ]
      })

      bridge.messageLog.record(mountEntry(1, "/App/Outer", OuterComp, { open: false }))
      bridge.messageLog.record(mountEntry(2, "/App/Inner", InnerComp, { section: "already-open" }))
      bridge.messageLog.record(mountEntry(3, "/App/Leaf", LeafComp, { dynamicSection: "already-open", done: false }))

      bridge.attachDispatcher({
        dispatch: (instance) =>
          Effect.sync(() => {
            if (instance === 1) {
              outerOpen = true
              bridge.messageLog.record(updateEntry(1, "/App/Outer", OuterComp, { open: true }))
              return true
            }
            if (instance === 2) {
              innerExpandCalls++
              return true
            }
            if (instance === 3) {
              bridge.messageLog.record(updateEntry(3, "/App/Leaf", LeafComp, { dynamicSection: "already-open", done: true }))
              return true
            }
            return false
          })
      })

      const res = await Effect.runPromise(bridge.act({ steps: [{ ref: "Leaf", action: "run" }] }))
      expect(res.ok).toBe(true)
      expect(innerExpandCalls).toBe(0)
      expect(res.revealed).toEqual([
        {
          container: "Outer",
          containerRef: "/App/Outer",
          action: "open",
          target: "Inner",
          targetRef: "/App/Inner"
        }
      ])
    }
  })
})
