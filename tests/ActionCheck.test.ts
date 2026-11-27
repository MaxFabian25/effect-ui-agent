import { describe, expect, test } from "bun:test"
import { UiSchema } from "@effect/ui"
import { Html } from "@effect/ui/html"
import { HtmlPlay } from "@effect/ui/html/testing"
import { TestHost } from "@effect/ui/testing"
import { Effect, Layer, Redacted, Schema } from "effect"
import { TestClock } from "effect/testing"
import * as AgentBridge from "../src/index.ts"

const Row = Schema.Struct({ id: Schema.String, label: Schema.String })
const QueueMsg = UiSchema.TaggedEnum({
  SetRows: { rows: Schema.Array(Row) },
  SetHidden: { hidden: Schema.Boolean },
  SetEnabled: { enabled: Schema.Boolean },
  Opened: { id: Schema.String },
  Deleted: { id: Schema.String },
  SavedToken: { token: Schema.Redacted(Schema.String) },
  NoopPing: {}
})

const QueueWidget = Html.component({
  name: "QueueWidget",
  model: Schema.Struct({
    rows: Schema.Array(Row),
    hidden: Schema.Boolean,
    enabled: Schema.Boolean,
    selectedId: Schema.NullOr(Schema.String),
    deletedIds: Schema.Array(Schema.String),
    dispatches: Schema.Number
  }),
  message: QueueMsg
}).make({
  init: () => ({
    rows: [
      { id: "gone", label: "Payroll reviewer" },
      { id: "live", label: "Payroll reviewer" }
    ],
    hidden: false,
    enabled: true,
    selectedId: null,
    deletedIds: [],
    dispatches: 0
  }),
  update: {
    SetRows: ($, { rows }) => $.evolve({ rows }),
    SetHidden: ($, { hidden }) => $.evolve({ hidden }),
    SetEnabled: ($, { enabled }) => $.evolve({ enabled }),
    Opened: ($, { id }) =>
      $.model.rows.some((row) => row.id === id)
        ? $.evolve({ selectedId: id, dispatches: $.model.dispatches + 1 })
        : $,
    Deleted: ($, { id }) =>
      $.evolve({
        rows: $.model.rows.filter((row) => row.id !== id),
        deletedIds: [...$.model.deletedIds, id],
        dispatches: $.model.dispatches + 1
      }),
    SavedToken: ($) => $.evolve({ dispatches: $.model.dispatches + 1 }),
    NoopPing: ($) => $
  },
  view: (h, model) => h.p.attr("role", "status").children(model.selectedId ?? "none")
})

const QueueContract = AgentBridge.expose(QueueWidget, {
  label: "Review queue",
  hidden: (model) => model.hidden,
  rows: (model) => ({ status: "ready", rows: model.rows }),
  state: (model) => ({ selectedId: model.selectedId, deletedIds: model.deletedIds }),
  actions: {
    openRow: {
      description: "Open a row from the queue",
      args: Schema.Struct({ id: Schema.String }),
      enabled: (model) => model.enabled && model.rows.length > 0,
      check: (model, { id }: { id: string }) =>
        model.rows.some((row) => row.id === id)
          ? undefined
          : "This review is no longer in the queue. Search again.",
      toMessage: ({ id }: { id: string }) => QueueMsg.Opened({ id })
    },
    deleteRow: {
      description: "Delete a row from the queue",
      args: Schema.Struct({ id: Schema.String }),
      enabled: (model) => model.enabled && model.rows.length > 0,
      confirm: (model, { id }: { id: string }) => {
        const match = model.rows.find((row) => row.id === id)
        return `Delete ${match?.label ?? id}`
      },
      check: (model, { id }: { id: string }) =>
        model.rows.some((row) => row.id === id)
          ? undefined
          : "This review is no longer in the queue. Search again.",
      toMessage: ({ id }: { id: string }) => QueueMsg.Deleted({ id })
    },
    setSecretToken: {
      description: "Save a secret token for a live row",
      secret: true,
      args: Schema.Struct({ id: Schema.String, token: Schema.RedactedFromValue(Schema.String) }),
      check: (model, { id }: { id: string }) =>
        model.rows.some((row) => row.id === id) ? undefined : "Unknown target row.",
      toMessage: ({ token }: { token: Redacted.Redacted<string> }) => QueueMsg.SavedToken({ token })
    },
    blankRejection: {
      description: "Action whose check returns whitespace",
      args: Schema.Struct({}),
      check: () => "   ",
      toMessage: () => QueueMsg.NoopPing()
    },
    ping: {
      description: "Legitimate repeat with no check",
      args: Schema.Struct({}),
      toMessage: () => QueueMsg.NoopPing()
    }
  }
})

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

const provideQueue = <A, E, R>(
  effect: Effect.Effect<A, E, R | AgentBridge.AgentBridgeService | TestHost.TestHost | TestClock.TestClock>
) =>
  Effect.scoped(effect).pipe(
    Effect.provide(
      Layer.mergeAll(
        AgentBridge.layer({ contracts: [QueueContract] }),
        TestHost.layer(),
        TestClock.layer()
      )
    )
  )

describe("AgentActionSpec.check", () => {
  test("refuses a removed row ID, stops the batch before the live ID, and accepts a fresh live call", () =>
    run(
      provideQueue(
        Effect.gen(function*() {
          const bridge = yield* AgentBridge.AgentBridgeService
          const play = yield* HtmlPlay.make(QueueWidget, {})
          yield* AgentBridge.attachTestRoot(bridge, play.root)

          expect(bridge.queryRows({ ref: "Review queue", text: "Payroll" })).toEqual({
            status: "ready",
            rows: [
              { id: "gone", label: "Payroll reviewer" },
              { id: "live", label: "Payroll reviewer" }
            ],
            more: false
          })

          play.root.send(QueueMsg.SetRows({ rows: [{ id: "live", label: "Payroll reviewer" }] }))
          yield* TestHost.settle

          const batch = yield* bridge.act({
            steps: [
              { ref: "Review queue", action: "openRow", args: { id: "gone" } },
              { ref: "Review queue", action: "openRow", args: { id: "live" } }
            ]
          })
          expect(batch).toEqual({
            ok: false,
            completed: 0,
            error: { step: 0, message: "This review is no longer in the queue. Search again." }
          })
          expect(play.root.model()!.selectedId).toBeNull()
          expect(play.root.model()!.dispatches).toBe(0)
          expect(bridge.audit()).toEqual([
            {
              ref: "/QueueWidget",
              label: "Review queue",
              action: "openRow",
              secret: false,
              args: { id: "gone" },
              confirmed: false,
              ok: false,
              error: "This review is no longer in the queue. Search again."
            }
          ])

          const fresh = yield* bridge.act({
            steps: [{ ref: "Review queue", action: "openRow", args: { id: "live" } }]
          })
          expect(fresh).toEqual({ ok: true, completed: 1 })
          expect(play.root.model()!.selectedId).toBe("live")
          expect(play.root.model()!.dispatches).toBe(1)
        })
      )
    ))

  test("counts earlier accepted steps when a later step fails check and skips subsequent steps", () =>
    run(
      provideQueue(
        Effect.gen(function*() {
          const bridge = yield* AgentBridge.AgentBridgeService
          const play = yield* HtmlPlay.make(QueueWidget, {})
          yield* AgentBridge.attachTestRoot(bridge, play.root)

          play.root.send(QueueMsg.SetRows({ rows: [{ id: "live", label: "Payroll reviewer" }] }))
          yield* TestHost.settle

          const result = yield* bridge.act({
            steps: [
              { ref: "Review queue", action: "openRow", args: { id: "live" } },
              { ref: "Review queue", action: "openRow", args: { id: "gone" } },
              { ref: "Review queue", action: "openRow", args: { id: "live" } }
            ]
          })
          expect(result).toEqual({
            ok: false,
            completed: 1,
            error: { step: 1, message: "This review is no longer in the queue. Search again." }
          })
          expect(play.root.model()!.selectedId).toBe("live")
          expect(play.root.model()!.dispatches).toBe(1)
          expect(bridge.audit()).toEqual([
            {
              ref: "/QueueWidget",
              label: "Review queue",
              action: "openRow",
              secret: false,
              args: { id: "live" },
              confirmed: false,
              ok: true
            },
            {
              ref: "/QueueWidget",
              label: "Review queue",
              action: "openRow",
              secret: false,
              args: { id: "gone" },
              confirmed: false,
              ok: false,
              error: "This review is no longer in the queue. Search again."
            }
          ])
        })
      )
    ))

  test("runs check before human confirmation and rechecks row, enabled, and hidden state after async approval", () =>
    run(
      provideQueue(
        Effect.gen(function*() {
          const bridge = yield* AgentBridge.AgentBridgeService
          const testHost = yield* TestHost.TestHost
          const play = yield* HtmlPlay.make(QueueWidget, {})
          yield* AgentBridge.attachTestRoot(bridge, play.root)

          const settle = () =>
            Effect.runPromise(TestHost.settle.pipe(Effect.provideService(TestHost.TestHost, testHost)))

          play.root.send(QueueMsg.SetRows({ rows: [{ id: "live", label: "Payroll reviewer" }] }))
          yield* TestHost.settle

          let allowCalls = 0
          const rejectedBeforeConfirm = yield* bridge.act(
            { steps: [{ ref: "Review queue", action: "deleteRow", args: { id: "gone" } }] },
            {
              allow: () => {
                allowCalls++
                return true
              }
            }
          )
          expect(rejectedBeforeConfirm).toEqual({
            ok: false,
            completed: 0,
            error: { step: 0, message: "This review is no longer in the queue. Search again." }
          })
          expect(allowCalls).toBe(0)

          const vanishedDuringApproval = yield* bridge.act(
            {
              steps: [
                { ref: "Review queue", action: "deleteRow", args: { id: "live" } },
                { ref: "Review queue", action: "openRow", args: { id: "other" } }
              ]
            },
            {
              allow: async () => {
                allowCalls++
                play.root.send(QueueMsg.SetRows({ rows: [{ id: "other", label: "Other row" }] }))
                await settle()
                return true
              }
            }
          )
          expect(allowCalls).toBe(1)
          expect(vanishedDuringApproval).toEqual({
            ok: false,
            completed: 0,
            error: { step: 0, message: "This review is no longer in the queue. Search again." }
          })
          expect(play.root.model()!.deletedIds).toEqual([])
          expect(play.root.model()!.selectedId).toBeNull()
          expect(bridge.audit().at(-1)).toMatchObject({
            action: "deleteRow",
            confirmed: true,
            ok: false,
            error: "This review is no longer in the queue. Search again."
          })

          const disabledDuringApproval = yield* bridge.act(
            { steps: [{ ref: "Review queue", action: "deleteRow", args: { id: "other" } }] },
            {
              allow: async () => {
                play.root.send(QueueMsg.SetEnabled({ enabled: false }))
                await settle()
                return true
              }
            }
          )
          expect(disabledDuringApproval).toEqual({
            ok: false,
            completed: 0,
            error: { step: 0, message: 'Action "deleteRow" is currently disabled' }
          })
          expect(play.root.model()!.deletedIds).toEqual([])
          expect(bridge.audit().at(-1)).toMatchObject({
            action: "deleteRow",
            confirmed: true,
            ok: false,
            error: 'Action "deleteRow" is currently disabled'
          })

          play.root.send(QueueMsg.SetEnabled({ enabled: true }))
          yield* TestHost.settle
          const hiddenDuringApproval = yield* bridge.act(
            { steps: [{ ref: "Review queue", action: "deleteRow", args: { id: "other" } }] },
            {
              allow: async () => {
                play.root.send(QueueMsg.SetHidden({ hidden: true }))
                await settle()
                return true
              }
            }
          )
          expect(hiddenDuringApproval).toEqual({
            ok: false,
            completed: 0,
            error: { step: 0, message: 'No visible control matches ref "Review queue"' }
          })
          expect(play.root.model()!.deletedIds).toEqual([])
          expect(bridge.audit().at(-1)).toMatchObject({
            action: "deleteRow",
            confirmed: true,
            ok: false,
            error: 'No visible control matches ref "Review queue"'
          })
        })
      )
    ))

  test("redacts secret args on check failure, fails closed on blank check string, and keeps unchecked repeats working", () =>
    run(
      provideQueue(
        Effect.gen(function*() {
          const bridge = yield* AgentBridge.AgentBridgeService
          const play = yield* HtmlPlay.make(QueueWidget, {})
          yield* AgentBridge.attachTestRoot(bridge, play.root)

          const secretFail = yield* bridge.act({
            steps: [
              {
                ref: "Review queue",
                action: "setSecretToken",
                args: { id: "missing", token: "sk-must-never-leak" }
              }
            ]
          })
          expect(secretFail).toEqual({
            ok: false,
            completed: 0,
            error: { step: 0, message: "Unknown target row." }
          })
          expect(JSON.stringify(bridge.audit())).not.toContain("sk-must-never-leak")
          expect(bridge.audit().at(-1)).toMatchObject({
            action: "setSecretToken",
            secret: true,
            args: "[Redacted]",
            ok: false,
            error: "Unknown target row."
          })

          const blankFail = yield* bridge.act({
            steps: [{ ref: "Review queue", action: "blankRejection" }]
          })
          expect(blankFail).toEqual({
            ok: false,
            completed: 0,
            error: { step: 0, message: 'Action "blankRejection" cannot run with these arguments' }
          })

          const repeats = yield* bridge.act({
            steps: [
              { ref: "Review queue", action: "ping" },
              { ref: "Review queue", action: "ping" }
            ]
          })
          expect(repeats).toEqual({ ok: true, completed: 2 })
        })
      )
    ))

  test("refuses dispatch when target label or confirmation text changes independently during async approval, and checks hidden before reading label", () => {
    const LabelOnlyContract = AgentBridge.expose(QueueWidget, {
      label: (model) => model.rows[0]!.label,
      hidden: (model) => model.rows.length === 0,
      state: (model) => ({ deletedIds: model.deletedIds }),
      actions: {
        deleteActive: {
          description: "Delete the active project",
          args: Schema.Struct({}),
          confirm: "Delete the active project",
          toMessage: () => QueueMsg.Deleted({ id: "live" })
        }
      }
    })
    const ConfirmOnlyContract = AgentBridge.expose(QueueWidget, {
      label: "Project panel",
      state: (model) => ({ deletedIds: model.deletedIds }),
      actions: {
        deleteActive: {
          description: "Delete the active project",
          args: Schema.Struct({}),
          confirm: (model) => `Delete ${model.rows[0]!.label}`,
          toMessage: () => QueueMsg.Deleted({ id: "live" })
        }
      }
    })

    return run(
      Effect.gen(function*() {
        yield* Effect.scoped(
          Effect.gen(function*() {
            const bridge = yield* AgentBridge.AgentBridgeService
            const testHost = yield* TestHost.TestHost
            const play = yield* HtmlPlay.make(QueueWidget, {})
            yield* AgentBridge.attachTestRoot(bridge, play.root)

            const settle = () =>
              Effect.runPromise(TestHost.settle.pipe(Effect.provideService(TestHost.TestHost, testHost)))

            play.root.send(QueueMsg.SetRows({ rows: [{ id: "live", label: "Project A" }] }))
            yield* TestHost.settle

            const labelChanged = yield* bridge.act(
              { steps: [{ ref: "Project A", action: "deleteActive" }] },
              {
                allow: async (request) => {
                  expect(request.label).toBe("Project A")
                  expect(request.confirm).toBe("Delete the active project")
                  play.root.send(QueueMsg.SetRows({ rows: [{ id: "live", label: "Project B" }] }))
                  await settle()
                  return true
                }
              }
            )
            expect(labelChanged).toEqual({
              ok: false,
              completed: 0,
              error: {
                step: 0,
                message:
                  'Approval for "deleteActive" on "Project A" is stale because the target changed. Ask the person again.'
              }
            })
            expect(play.root.model()!.deletedIds).toEqual([])
            expect(bridge.audit().at(-1)).toMatchObject({
              label: "Project A",
              action: "deleteActive",
              confirmed: true,
              ok: false,
              error:
                'Approval for "deleteActive" on "Project A" is stale because the target changed. Ask the person again.'
            })

            const hiddenWhileApproving = yield* bridge.act(
              { steps: [{ ref: "Project B", action: "deleteActive" }] },
              {
                allow: async () => {
                  play.root.send(QueueMsg.SetRows({ rows: [] }))
                  await settle()
                  return true
                }
              }
            )
            expect(hiddenWhileApproving).toEqual({
              ok: false,
              completed: 0,
              error: { step: 0, message: 'No visible control matches ref "Project B"' }
            })
            expect(play.root.model()!.deletedIds).toEqual([])
            expect(bridge.audit().at(-1)).toMatchObject({
              label: "Project B",
              action: "deleteActive",
              confirmed: true,
              ok: false,
              error: 'No visible control matches ref "Project B"'
            })
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                AgentBridge.layer({ contracts: [LabelOnlyContract] }),
                TestHost.layer(),
                TestClock.layer()
              )
            )
          )
        )

        yield* Effect.scoped(
          Effect.gen(function*() {
            const bridge = yield* AgentBridge.AgentBridgeService
            const testHost = yield* TestHost.TestHost
            const play = yield* HtmlPlay.make(QueueWidget, {})
            yield* AgentBridge.attachTestRoot(bridge, play.root)

            const settle = () =>
              Effect.runPromise(TestHost.settle.pipe(Effect.provideService(TestHost.TestHost, testHost)))

            play.root.send(QueueMsg.SetRows({ rows: [{ id: "live", label: "Project A" }] }))
            yield* TestHost.settle

            const confirmChanged = yield* bridge.act(
              { steps: [{ ref: "Project panel", action: "deleteActive" }] },
              {
                allow: async (request) => {
                  expect(request.label).toBe("Project panel")
                  expect(request.confirm).toBe("Delete Project A")
                  play.root.send(QueueMsg.SetRows({ rows: [{ id: "live", label: "Project B" }] }))
                  await settle()
                  return true
                }
              }
            )
            expect(confirmChanged).toEqual({
              ok: false,
              completed: 0,
              error: {
                step: 0,
                message:
                  'Approval for "deleteActive" on "Project panel" is stale because the target changed. Ask the person again.'
              }
            })
            expect(play.root.model()!.deletedIds).toEqual([])
            expect(bridge.audit().at(-1)).toMatchObject({
              label: "Project panel",
              action: "deleteActive",
              confirmed: true,
              ok: false,
              error:
                'Approval for "deleteActive" on "Project panel" is stale because the target changed. Ask the person again.'
            })
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                AgentBridge.layer({ contracts: [ConfirmOnlyContract] }),
                TestHost.layer(),
                TestClock.layer()
              )
            )
          )
        )
      })
    )
  })
})
