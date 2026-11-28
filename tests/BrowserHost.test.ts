import { describe, expect, test } from "bun:test";
import { MessageLog, UiSchema } from "@effect/ui";
import { BrowserHost, Html } from "@effect/ui/html";
import { Effect, Layer, Predicate, Schema } from "effect";
import { GlobalWindow } from "happy-dom";
import * as AgentBridge from "../src/index.ts";
import {
  assertActionDiscoverable,
  assertActionNotDiscoverable,
} from "../src/testing.ts";
import {
  ProjectSettings,
  ProjectSettingsAgent,
} from "./fixtures/ProjectSettings.ts";

const WorkspaceMessage = UiSchema.TaggedEnum({
  RemoveProject: { key: Schema.String },
});

const Workspace = Html.component({
  name: "Workspace",
  model: Schema.Struct({
    projects: Schema.Array(
      Schema.Struct({ key: Schema.String, locked: Schema.Boolean }),
    ),
  }),
  message: WorkspaceMessage,
}).make({
  init: () => ({
    projects: [
      { key: "alpha", locked: false },
      { key: "beta", locked: false },
    ],
  }),
  update: {
    RemoveProject: ($, { key }) =>
      $.evolve({
        projects: $.model.projects.filter((p) => p.key !== key),
      }),
  },
  view: (h, model) =>
    h.main.children(
      model.projects.map((p) =>
        h.article
          .key(p.key)
          .attr("data-project", p.key)
          .children(
            ProjectSettings(h, {
              key: p.key,
              props: { lockedForAgents: p.locked },
            }),
          ),
      ),
    ),
});

const WorkspaceAgent = AgentBridge.expose(Workspace, {
  label: "Workspace",
  state: (model) => ({ projectKeys: model.projects.map((p) => p.key) }),
  actions: {
    removeProject: {
      description: "Unmount a project panel from the workspace",
      args: Schema.Struct({ key: Schema.String }),
      toMessage: ({ key }) => WorkspaceMessage.RemoveProject({ key }),
    },
  },
});

const ProjectRowsAgent = {
  ...ProjectSettingsAgent,
  rows: (model): AgentBridge.AgentRows => ({
    status: "ready",
    rows: [{ id: "project-name", label: model.name }],
  }),
} satisfies typeof ProjectSettingsAgent;

const withHappyDom = async <A>(
  fn: (win: GlobalWindow) => Promise<A>,
): Promise<A> => {
  const win = new GlobalWindow({ url: "http://localhost/" });
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
    "queueMicrotask",
  ] as const;
  const prev: Record<string, unknown> = {};
  for (const k of keys) prev[k] = globalThis[k];
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
    getComputedStyle: win.getComputedStyle.bind(win),
  });
  try {
    return await fn(win);
  } finally {
    Object.assign(globalThis, prev);
    await win.happyDOM.close();
  }
};

const nextFrame = () => Bun.sleep(25);

describe("BrowserHost.mountEffect + nested children + Controllables chaining", () => {
  test("dispatches to a specific nested child via BrowserHost.Controllables and removes unmounted children", async () => {
    await withHappyDom(async () => {
      const container = globalThis.document.createElement("div");
      globalThis.document.body.appendChild(container);

      const upstreamEntries: Array<MessageLog.Entry> = [];
      const upstreamRoots: Array<string> = [];
      let upstreamUnregistered = 0;

      const UpstreamDevToolsLike = Layer.mergeAll(
        Layer.succeed(MessageLog.MessageLog, {
          enabled: true,
          record: (entry) => {
            upstreamEntries.push(entry);
          },
        }),
        Layer.succeed(BrowserHost.Controllables, {
          register: (root) => {
            upstreamRoots.push(root.path);
            return () => {
              upstreamUnregistered++;
            };
          },
        }),
      );

      const AppLayer = AgentBridge.layer({
        contracts: [WorkspaceAgent, ProjectRowsAgent],
      }).pipe(Layer.provide(UpstreamDevToolsLike));

      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const bridge = yield* AgentBridge.AgentBridgeService;
            yield* BrowserHost.mountEffect(Workspace, {}, container);
            yield* Effect.promise(nextFrame);

            // Both nested children AND parent are discovered automatically
            const initial = bridge.snapshot();
            expect(initial.map((e) => e.ref).sort()).toEqual([
              "/Workspace",
              "/Workspace/ProjectSettings[alpha]",
              "/Workspace/ProjectSettings[beta]",
            ]);
            expect(() =>
              assertActionDiscoverable(bridge, {
                label: "Project settings",
                action: "setName",
              }),
            ).toThrow(/^Ambiguous action: .*found 2\.$/);
            const beta = {
              ref: "/Workspace/ProjectSettings[beta]",
              action: "setName",
            };
            assertActionDiscoverable(bridge, beta);
            expect(bridge.queryRows({ ref: "Project settings" })).toEqual({
              status: "unavailable",
            });
            expect(bridge.queryRows({ ref: "/Workspace" })).toEqual({
              status: "unavailable",
            });

            // Upstream DevTools-like layer ALSO received Controllable registration & MessageLog entries
            expect(upstreamRoots).toEqual(["/Workspace"]);
            expect(
              upstreamEntries.some(
                (e) =>
                  Predicate.isTagged(e, "Mounted") &&
                  e.path === "/Workspace/ProjectSettings[beta]",
              ),
            ).toBe(true);

            // Ambiguous label ("Project settings") fails clearly naming both nested child refs
            const ambiguous = yield* bridge.act({
              steps: [
                {
                  ref: "Project settings",
                  action: "setName",
                  args: { name: "Oops" },
                },
              ],
            });
            expect(ambiguous.ok).toBe(false);
            expect(ambiguous.error?.message).toContain(
              "/Workspace/ProjectSettings[alpha]",
            );
            expect(ambiguous.error?.message).toContain(
              "/Workspace/ProjectSettings[beta]",
            );

            // Dispatch directly to nested child beta via BrowserHost.Controllables
            const renamed = yield* bridge.act({
              steps: [
                {
                  ref: "/Workspace/ProjectSettings[beta]",
                  action: "setName",
                  args: { name: "Beta Renamed" },
                },
              ],
            });
            expect(renamed).toMatchObject({ ok: true, completed: 1 });
            expect(
              renamed.state.find(
                (e) => e.ref === "/Workspace/ProjectSettings[beta]",
              )?.state.name,
            ).toBe("Beta Renamed");
            yield* Effect.promise(nextFrame);

            const alphaHeading = container.querySelector(
              '[data-project="alpha"] h1',
            )?.textContent;
            const betaHeading = container.querySelector(
              '[data-project="beta"] h1',
            )?.textContent;
            expect(alphaHeading).toBe("Default project");
            expect(betaHeading).toBe("Beta Renamed");
            expect(bridge.queryRows({ ref: beta.ref, text: "beta" })).toEqual({
              status: "ready",
              rows: [{ id: "project-name", label: "Beta Renamed" }],
              more: false,
            });
            expect(
              bridge.queryRows({
                ref: "/Workspace/ProjectSettings[alpha]",
                text: "beta",
              }),
            ).toEqual({
              status: "ready",
              rows: [],
              more: false,
            });

            // Unmount child beta via parent Workspace action -> disappears from snapshot
            const removed = yield* bridge.act({
              steps: [
                {
                  ref: "Workspace",
                  action: "removeProject",
                  args: { key: "beta" },
                },
              ],
            });
            expect(removed).toMatchObject({ ok: true, completed: 1 });
            yield* Effect.promise(nextFrame);

            expect(
              bridge
                .snapshot()
                .map((e) => e.ref)
                .sort(),
            ).toEqual(["/Workspace", "/Workspace/ProjectSettings[alpha]"]);
            assertActionNotDiscoverable(bridge, beta);
            assertActionDiscoverable(bridge, {
              label: "Project settings",
              action: "setName",
            });
            expect(bridge.queryRows({ ref: beta.ref })).toEqual({
              status: "unavailable",
            });
            expect(bridge.queryRows({ ref: "Project settings" })).toMatchObject(
              { status: "ready" },
            );
          }).pipe(Effect.provide(AppLayer)),
        ),
      );

      // Closing the Scope unregistered both AgentBridge and upstream Controllables
      expect(upstreamUnregistered).toBe(1);
    });
  });
});
