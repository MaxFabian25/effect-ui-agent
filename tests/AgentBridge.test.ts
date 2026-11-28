import { describe, expect, test } from "bun:test";
import { HtmlLocator, HtmlPlay } from "@effect/ui/html/testing";
import { Locator, TestHost } from "@effect/ui/testing";
import { Effect, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";
import * as AgentBridge from "../src/index.ts";
import {
  assertActionDiscoverable,
  assertActionNotDiscoverable,
} from "../src/testing.ts";
import {
  ProjectSettings,
  ProjectSettingsAgent,
  SettingsMessage,
} from "./fixtures/ProjectSettings.ts";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("Native Effect UI AgentBridge", () => {
  test("snapshot, query, and act drive the live UI and never leak Schema.Redacted secrets", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* AgentBridge.AgentBridgeService;
          const play = yield* HtmlPlay.make(ProjectSettings, {});
          yield* AgentBridge.attachTestRoot(bridge, play.root);

          const snap = bridge.snapshot();
          expect(snap).toHaveLength(1);
          expect(snap[0]?.label).toBe("Project settings");
          // Defense-in-depth: Redacted field returned by state() is scrubbed automatically
          expect(snap[0]?.state.apiKey).toBe("[Redacted]");
          expect(JSON.stringify(snap)).not.toContain("sk-initial-super-secret");
          expect(snap[0]?.actions.map((a) => a.name)).toContain(
            "setVisibility",
          );
          assertActionDiscoverable(bridge, {
            label: "Project settings",
            action: "setVisibility",
          });

          const queried = bridge.query({ text: "visibility" });
          expect(queried).toHaveLength(1);

          const result = yield* bridge.act({
            steps: [
              {
                ref: "Project settings",
                action: "setName",
                args: { name: "Atlas" },
              },
              {
                ref: "Project settings",
                action: "setVisibility",
                args: { visibility: "internal" },
              },
              {
                ref: "Project settings",
                action: "setWeeklyDigest",
                args: { enabled: true },
              },
            ],
          });
          expect(result).toEqual({
            ok: true,
            completed: 3,
            state: [
              {
                ref: "/ProjectSettings",
                label: "Project settings",
                state: {
                  name: "Atlas",
                  visibility: "internal",
                  weeklyDigest: true,
                  deleted: false,
                  hasApiKey: true,
                  apiKey: "[Redacted]",
                },
              },
            ],
          });
          expect(JSON.stringify(result)).not.toContain(
            "sk-initial-super-secret",
          );

          yield* play.expect(Locator.tag("h1")).toHaveText("Atlas");
          yield* play
            .expect(HtmlLocator.role("textbox", { name: "Project name" }))
            .toHaveValue("Atlas");
          expect(bridge.snapshot()[0]?.state.visibility).toBe("internal");
          expect(bridge.snapshot()[0]?.state.weeklyDigest).toBe(true);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              AgentBridge.layer({ contracts: [ProjectSettingsAgent] }),
              TestHost.layer(),
              TestClock.layer(),
            ),
          ),
        ),
      ),
    ));

  test("Schema boundary rejects closed-set enum mismatches and excess properties", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* AgentBridge.AgentBridgeService;
          const play = yield* HtmlPlay.make(ProjectSettings, {});
          yield* AgentBridge.attachTestRoot(bridge, play.root);

          const badEnum = yield* bridge.act({
            steps: [
              {
                ref: "Project settings",
                action: "setVisibility",
                args: { visibility: "worldwide" },
              },
            ],
          });
          expect(badEnum.ok).toBe(false);
          expect(badEnum.error?.message).toContain("Invalid args");

          const excess = yield* bridge.act({
            steps: [
              {
                ref: "Project settings",
                action: "setName",
                args: { name: "Ok", sneaky: true },
              },
            ],
          });
          expect(excess.ok).toBe(false);
          expect(excess.error?.message).toContain("Invalid args");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              AgentBridge.layer({ contracts: [ProjectSettingsAgent] }),
              TestHost.layer(),
              TestClock.layer(),
            ),
          ),
        ),
      ),
    ));

  test("a human-only action still works in the UI and is absent from discovery", () => {
    const { deleteProject: _humanOnly, ...actions } =
      ProjectSettingsAgent.actions;
    return run(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* AgentBridge.AgentBridgeService;
          const play = yield* HtmlPlay.make(ProjectSettings, {});
          yield* AgentBridge.attachTestRoot(bridge, play.root);

          assertActionDiscoverable(bridge, {
            label: "Project settings",
            action: "setName",
          });
          assertActionNotDiscoverable(bridge, {
            label: "Project",
            action: "setName",
          });
          assertActionNotDiscoverable(bridge, {
            label: "Project settings",
            action: "SetName",
          });
          const selector = {
            label: "Project settings",
            action: "deleteProject",
          };
          assertActionNotDiscoverable(bridge, selector);
          expect(() => assertActionDiscoverable(bridge, selector)).toThrow(
            /^Missing action: .*found 0\.$/,
          );

          yield* play.click(
            HtmlLocator.role("button", { name: "Delete project" }),
          );
          yield* play.expect(Locator.tag("h1")).toHaveText("Deleted");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              AgentBridge.layer({
                contracts: [{ ...ProjectSettingsAgent, actions }],
              }),
              TestHost.layer(),
              TestClock.layer(),
            ),
          ),
        ),
      ),
    );
  });

  test("secret actions fill Schema.Redacted fields without leaking to snapshot or audit log", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* AgentBridge.AgentBridgeService;
          const play = yield* HtmlPlay.make(ProjectSettings, {});
          yield* AgentBridge.attachTestRoot(bridge, play.root);

          const result = yield* bridge.act({
            steps: [
              {
                ref: "Project settings",
                action: "setApiKey",
                args: { apiKey: "sk-live-98765" },
              },
            ],
          });
          expect(result.ok).toBe(true);
          expect(JSON.stringify(result)).not.toContain("sk-live-98765");
          expect(result.state[0]?.state.apiKey).toBe("[Redacted]");
          const updatedModel = play.root.model();
          if (updatedModel === undefined)
            throw new Error("Expected mounted model");
          expect(Redacted.value(updatedModel.apiKey)).toBe("sk-live-98765");
          expect(JSON.stringify(bridge.snapshot())).not.toContain(
            "sk-live-98765",
          );
          expect(JSON.stringify(bridge.audit())).not.toContain("sk-live-98765");
          expect(bridge.audit()[0]?.args).toBe("[Redacted]");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              AgentBridge.layer({ contracts: [ProjectSettingsAgent] }),
              TestHost.layer(),
              TestClock.layer(),
            ),
          ),
        ),
      ),
    ));

  test("confirm gate fails closed without allow, refuses on deny, and runs on approval with live Model text", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* AgentBridge.AgentBridgeService;
          const play = yield* HtmlPlay.make(ProjectSettings, {});
          yield* AgentBridge.attachTestRoot(bridge, play.root);

          const selector = {
            label: "Project settings",
            action: "deleteProject",
          };
          assertActionDiscoverable(bridge, selector);
          expect(() => assertActionNotDiscoverable(bridge, selector)).toThrow(
            /^Unexpected exposure: expected no advertised matches by exact label; found 1\.$/,
          );
          expect(bridge.audit()).toEqual([]);

          yield* bridge.act({
            steps: [
              {
                ref: "Project settings",
                action: "setName",
                args: { name: "Atlas" },
              },
            ],
          });

          // No allow callback => fails closed
          const blocked = yield* bridge.act({
            steps: [{ ref: "Project settings", action: "deleteProject" }],
          });
          expect(blocked.ok).toBe(false);
          expect(blocked.error?.message).toBe(
            'Needs a person: Deletes "Atlas" and all its files',
          );
          expect(play.root.model()?.deleted).toBe(false);

          // allow returns false => refused
          const prompts: Array<string> = [];
          const denied = yield* bridge.act(
            { steps: [{ ref: "Project settings", action: "deleteProject" }] },
            {
              allow: (req) => {
                prompts.push(req.confirm);
                return false;
              },
            },
          );
          expect(denied.ok).toBe(false);
          expect(prompts).toEqual(['Deletes "Atlas" and all its files']);
          expect(play.root.model()?.deleted).toBe(false);

          // allow returns true => runs and disables deleteProject afterwards
          const approved = yield* bridge.act(
            { steps: [{ ref: "Project settings", action: "deleteProject" }] },
            { allow: () => true },
          );
          expect(approved.ok).toBe(true);
          expect(play.root.model()?.deleted).toBe(true);
          assertActionNotDiscoverable(bridge, selector);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              AgentBridge.layer({ contracts: [ProjectSettingsAgent] }),
              TestHost.layer(),
              TestClock.layer(),
            ),
          ),
        ),
      ),
    ));

  test("hidden controls vanish from snapshot and act, and source='agent' lets update enforce policy", () =>
    run(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* AgentBridge.AgentBridgeService;
          const play = yield* HtmlPlay.make(ProjectSettings, {
            lockedForAgents: true,
          });
          yield* AgentBridge.attachTestRoot(bridge, play.root);

          // Agent edit blocked by component policy, human edit still works
          yield* bridge.act({
            steps: [
              {
                ref: "Project settings",
                action: "setName",
                args: { name: "Hijacked" },
              },
            ],
          });
          expect(play.root.model()?.name).toBe("Default project");
          yield* play
            .expect(HtmlLocator.role("status"))
            .toHaveText("Agent edits are blocked by workspace policy");

          yield* play.type(
            HtmlLocator.role("textbox", { name: "Project name" }),
            "Human edit",
          );
          expect(play.root.model()?.name).toBe("Human edit");

          // Showing recovery codes hides the component from agents completely
          play.root.send(SettingsMessage.ToggledRecoveryCodes());
          yield* TestHost.settle;
          expect(bridge.snapshot()).toEqual([]);
          const hiddenAttempt = yield* bridge.act({
            steps: [
              {
                ref: "Project settings",
                action: "setWeeklyDigest",
                args: { enabled: true },
              },
            ],
          });
          expect(hiddenAttempt.ok).toBe(false);
          expect(hiddenAttempt.state).toEqual([]);
          expect(hiddenAttempt.error?.message).toContain("No visible control");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              AgentBridge.layer({ contracts: [ProjectSettingsAgent] }),
              TestHost.layer(),
              TestClock.layer(),
            ),
          ),
        ),
      ),
    ));

  test("registerWebMcp registers tools on ModelContext, runs act through WebMCP, and cleans up on Scope close", async () => {
    const registered: Array<{
      tool: AgentBridge.ModelContextTool;
      signal?: AbortSignal | undefined;
    }> = [];
    const fakeContext: AgentBridge.ModelContext = {
      registerTool: (tool, opts) => {
        registered.push({ tool, signal: opts?.signal });
      },
    };

    await run(
      Effect.scoped(
        Effect.gen(function* () {
          const bridge = yield* AgentBridge.AgentBridgeService;
          const play = yield* HtmlPlay.make(ProjectSettings, {});
          yield* AgentBridge.attachTestRoot(bridge, play.root);

          yield* bridge.registerWebMcp(fakeContext, {
            prefix: "app_",
            allow: () => true,
          });

          expect(registered.map((r) => r.tool.name)).toEqual([
            "app_snapshot",
            "app_query",
            "app_act",
          ]);
          expect(registered.every((r) => r.signal?.aborted === false)).toBe(
            true,
          );

          const actTool = registered.find(
            (r) => r.tool.name === "app_act",
          )?.tool;
          if (actTool === undefined)
            throw new Error("Expected app_act tool to be registered");
          const res = yield* Effect.promise(() =>
            actTool.execute({
              steps: [
                {
                  ref: "Project settings",
                  action: "setName",
                  args: { name: "Via WebMCP" },
                },
              ],
            }),
          );
          expect(res).toMatchObject({
            ok: true,
            completed: 1,
            state: [
              {
                ref: "/ProjectSettings",
                label: "Project settings",
                state: { name: "Via WebMCP", apiKey: "[Redacted]" },
              },
            ],
          });
          expect(play.root.model()?.name).toBe("Via WebMCP");
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              AgentBridge.layer({ contracts: [ProjectSettingsAgent] }),
              TestHost.layer(),
              TestClock.layer(),
            ),
          ),
        ),
      ),
    );

    // Scope closed => every registered WebMCP tool aborted cleanly
    expect(registered.every((r) => r.signal?.aborted === true)).toBe(true);
  });
});
