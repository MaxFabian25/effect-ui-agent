import { UiSchema } from "@effect/ui"
import { BrowserHost, Html } from "@effect/ui/html"
import { describe, expect, it } from "bun:test"
import { Effect, Schema } from "effect"
import { GlobalWindow } from "happy-dom"
import * as AgentBridge from "../src/AgentBridge.js"

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
    prev[k] = (globalThis as Record<string, unknown>)[k]
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

const nextFrame = () => new Promise<void>((resolve) => setTimeout(resolve, 25))

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
    await withHappyDom(async (win) => {
      const container = win.document.createElement("div")
      win.document.body.appendChild(container)

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
            yield* BrowserHost.mountEffect(SettingsShell, {}, container as unknown as Element)
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
              { container: "Settings Tabs", action: "select", target: "Advanced Accordion" },
              { container: "Advanced Accordion", action: "expand", target: "Webhook URL" }
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
    await withHappyDom(async (win) => {
      const container = win.document.createElement("div")
      win.document.body.appendChild(container)

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
            yield* BrowserHost.mountEffect(EdgeShell, {}, container as unknown as Element)
            yield* Effect.promise(nextFrame)

            const stuckRes = yield* bridge.act({ steps: [{ ref: "Stuck Target", action: "go" }] })
            expect(stuckRes.ok).toBe(false)
            expect(stuckRes.error?.message).toContain("did not make")

            const cycleRes = yield* bridge.act({ steps: [{ ref: "Cycle A", action: "open" }] })
            expect(cycleRes.ok).toBe(false)
            expect(cycleRes.error?.message).toContain("cycle")
          })
        ).pipe(Effect.provide(bridgeLayer))
      )
    })
  })
})
