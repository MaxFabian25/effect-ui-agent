import { expect, test } from "bun:test"
import { UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing"
import { TestHost } from "@effect/ui/testing"
import { Effect, Layer, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as AgentBridge from "../src/index.ts"

const ReadStatus = Schema.Literals(["loading", "ready", "refreshing", "failed"])
const Row = Schema.Struct({ id: Schema.String, label: Schema.String, privateNote: Schema.String })
const ListMessage = UiSchema.TaggedEnum({
  ReadChanged: { status: ReadStatus },
  Cleared: {},
  Hidden: {},
  Opened: {}
})

const ReviewQueue = Html.component({
  name: "ReviewQueue",
  model: Schema.Struct({ status: ReadStatus, rows: Schema.Array(Row), hidden: Schema.Boolean, open: Schema.Boolean }),
  message: ListMessage
}).make({
  init: () => ({
    status: "loading",
    hidden: false,
    open: false,
    rows: Array.from({ length: 60 }, (_, index) => ({
      id: `review-${index + 1}`,
      label: index === 13 || index === 54 ? "Payroll reviewer" : `Inventory ${index + 1}`,
      privateNote: "not-searchable-fixture"
    }))
  }),
  update: {
    ReadChanged: ($, { status }) => $.evolve({ status }),
    Cleared: ($) => $.evolve({ rows: [] }),
    Hidden: ($) => $.evolve({ hidden: true }),
    Opened: ($) => $.evolve({ open: true })
  },
  view: (h, model) => h.p.attr("role", "status").children(model.open ? "Review open" : "Review closed")
})

const ReviewQueueAgent = AgentBridge.expose(ReviewQueue, {
  label: "Review AI Act levels",
  hidden: (model) => model.hidden,
  state: ({ open }) => ({ open }),
  rows: ({ status, rows }) => status === "ready" ? { status, rows } : { status },
  actions: {
    open: {
      description: "Open a review",
      args: Schema.Struct({}),
      toMessage: () => ListMessage.Opened()
    }
  }
})

test("WebMCP finds public rows in a closed mounted list without downloading its snapshot", async () => {
  const registered = new Map<string, { tool: AgentBridge.ModelContextTool; signal?: AbortSignal | undefined }>()
  const request = { ref: "Review AI Act levels", text: "pAyRoLl", limit: 1 }

  await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
    const bridge = yield* AgentBridge.AgentBridgeService
    const play = yield* HtmlPlay.make(ReviewQueue, {})
    yield* AgentBridge.attachTestRoot(bridge, play.root)
    yield* bridge.registerWebMcp({
      registerTool: (tool, options) => registered.set(tool.name, { tool, signal: options?.signal })
    }, { prefix: "app_", allow: () => { throw new Error("Row lookup must not ask for confirmation") } })

    const registration = registered.get("app_query_rows")
    if (!registration) throw new Error("The row lookup tool was not registered")
    const { tool, signal } = registration
    expect(signal?.aborted).toBe(false)
    expect(tool.annotations).toEqual({ readOnlyHint: true })
    expect(tool.inputSchema).toMatchObject({ required: ["ref"], additionalProperties: false })
    expect(yield* Effect.promise(() => tool.execute(request))).toEqual({ status: "loading" })

    play.root.send(ListMessage.ReadChanged({ status: "ready" }))
    yield* TestHost.settle
    expect(yield* Effect.promise(() => tool.execute(request))).toEqual({
      status: "ready", rows: [{ id: "review-14", label: "Payroll reviewer" }], more: true
    })
    expect(yield* Effect.promise(() => tool.execute({ ...request, offset: 1 }))).toEqual({
      status: "ready", rows: [{ id: "review-55", label: "Payroll reviewer" }], more: false
    })
    yield* Effect.promise(async () => {
      for (const input of [{ text: "Payroll" }, { ...request, limit: 51 }, { ...request, offset: -1 }, { ...request, extra: true }]) {
        await expect(tool.execute(input)).rejects.toThrow(Schema.SchemaError)
      }
    })

    const before = bridge.snapshot()
    const readyEmpty = { status: "ready", rows: [], more: false } satisfies AgentBridge.RowQueryResult
    expect(bridge.queryRows({ ...request, ref: "Review AI Act" })).toEqual({ status: "unavailable" })
    expect(bridge.queryRows({ ...request, offset: 2 })).toEqual(readyEmpty)
    expect(bridge.queryRows({ ...request, text: "not-searchable-fixture" })).toEqual(readyEmpty)
    expect(bridge.queryRows({ ...request, text: "REVIEW-14" })).toEqual({
      status: "ready", rows: [{ id: "review-14", label: "Payroll reviewer" }], more: false
    })
    const first = bridge.queryRows({ ref: request.ref })
    expect(first).toMatchObject({ status: "ready", more: true })
    if (first.status !== "ready") throw new Error("Expected a ready row page")
    expect(first.rows).toHaveLength(10)
    const rest = bridge.queryRows({ ref: request.ref, offset: first.rows.length, limit: 50 })
    expect(rest).toMatchObject({ status: "ready", more: false })
    if (rest.status !== "ready") throw new Error("Expected a ready row page")
    expect([...first.rows, ...rest.rows].map((row) => row.id)).toEqual(
      Array.from({ length: 60 }, (_, index) => `review-${index + 1}`)
    )
    expect(bridge.snapshot()).toEqual(before)
    expect(bridge.query({ text: "Payroll" })).toEqual([])
    expect(bridge.audit()).toEqual([])
    yield* play.expect(HtmlLocator.role("status")).toHaveText("Review closed")

    for (const status of ["refreshing", "failed"] as const) {
      play.root.send(ListMessage.ReadChanged({ status }))
      yield* TestHost.settle
      expect(bridge.queryRows(request)).toEqual({ status })
    }
    play.root.send(ListMessage.Cleared())
    play.root.send(ListMessage.ReadChanged({ status: "ready" }))
    yield* TestHost.settle
    expect(bridge.queryRows(request)).toEqual(readyEmpty)

    play.root.send(ListMessage.Hidden())
    yield* TestHost.settle
    expect(bridge.queryRows(request)).toEqual({ status: "unavailable" })
    expect(bridge.queryRows({ ref: "/ReviewQueue" })).toEqual({ status: "unavailable" })
  }).pipe(Effect.provide(Layer.mergeAll(
    AgentBridge.layer({ contracts: [ReviewQueueAgent] }),
    TestHost.layer(),
    TestClock.layer()
  )))))

  expect(registered.get("app_query_rows")?.signal?.aborted).toBe(true)
})
