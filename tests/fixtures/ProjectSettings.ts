import { UiSchema } from "@effect/ui";
import { Html } from "@effect/ui/html";
import { Button, Field, Input, Select, Switch } from "@effect/ui-kit";
import { Redacted, Schema } from "effect";
import * as AgentBridge from "../../src/index.ts";

export const Visibility = Schema.Literals(["public", "internal", "private"]);
export type Visibility = typeof Visibility.Type;

const SourceSchema = Schema.Literals(["user", "agent"]);

export const SettingsMessage = UiSchema.TaggedEnum({
  UpdatedName: { name: Schema.String, source: SourceSchema },
  OpenedVisibility: {},
  ClosedVisibility: {},
  PickedVisibility: { visibility: Visibility, source: SourceSchema },
  ToggledDigest: { checked: Schema.Boolean, source: SourceSchema },
  UpdatedApiKey: {
    apiKey: Schema.Redacted(Schema.String),
    source: SourceSchema,
  },
  ToggledRecoveryCodes: {},
  DeletedProject: { source: SourceSchema },
});
export type SettingsMessage = typeof SettingsMessage.Type;

export const SettingsModel = Schema.Struct({
  name: Schema.String,
  visibility: Visibility,
  visibilityOpen: Schema.Boolean,
  weeklyDigest: Schema.Boolean,
  apiKey: Schema.Redacted(Schema.String),
  lockedForAgents: Schema.Boolean,
  showingRecoveryCodes: Schema.Boolean,
  deleted: Schema.Boolean,
  notice: Schema.NullOr(Schema.String),
});

const visibilityItems = [
  { value: "public", label: "Public" },
  { value: "internal", label: "Internal" },
  { value: "private", label: "Private" },
] as const;

export const ProjectSettings = Html.component({
  name: "ProjectSettings",
  props: Schema.Struct({
    lockedForAgents: Schema.optional(Schema.Boolean),
  }),
  model: SettingsModel,
  message: SettingsMessage,
}).make({
  init: ($) => ({
    name: "Default project",
    visibility: "private" as const,
    visibilityOpen: false,
    weeklyDigest: false,
    apiKey: Redacted.make("sk-initial-super-secret"),
    lockedForAgents: $.props.lockedForAgents ?? false,
    showingRecoveryCodes: false,
    deleted: false,
    notice: null,
  }),
  update: {
    UpdatedName: ($, { name, source }) =>
      $.model.lockedForAgents && source === "agent"
        ? $.evolve({ notice: "Agent edits are blocked by workspace policy" })
        : $.evolve({ name, notice: null }),
    OpenedVisibility: ($) => $.evolve({ visibilityOpen: true }),
    ClosedVisibility: ($) => $.evolve({ visibilityOpen: false }),
    PickedVisibility: ($, { visibility, source }) =>
      $.model.lockedForAgents && source === "agent"
        ? $.evolve({ notice: "Agent edits are blocked by workspace policy" })
        : $.evolve({ visibility, visibilityOpen: false, notice: null }),
    ToggledDigest: ($, { checked }) =>
      $.evolve({ weeklyDigest: checked, notice: null }),
    UpdatedApiKey: ($, { apiKey }) =>
      $.evolve({ apiKey, notice: "API key updated" }),
    ToggledRecoveryCodes: ($) =>
      $.evolve({ showingRecoveryCodes: !$.model.showingRecoveryCodes }),
    DeletedProject: ($) =>
      $.evolve({ deleted: true, notice: "Project deleted" }),
  },
  view: (h, model) =>
    h.section.class("space-y-4").children(
      h.h1(model.deleted ? "Deleted" : model.name),
      model.notice !== null
        ? h.p.attr("role", "status").children(model.notice)
        : undefined,
      Field(h, {
        key: "name",
        props: { filled: model.name.length > 0 },
        view: (field) =>
          field.root(h.div).children(
            field.label(h.label).children("Project name"),
            Input(h, {
              element: field.control(h.input),
              props: { value: model.name },
              onUpdate: ({ value }) =>
                SettingsMessage.UpdatedName({ name: value, source: "user" }),
            }),
          ),
      }),
      Field(h, {
        key: "visibility",
        props: { filled: true },
        view: (field) =>
          Select(h, {
            props: {
              open: model.visibilityOpen,
              value: model.visibility,
              items: [...visibilityItems],
              name: "visibility",
            },
            onEmit: {
              RequestedOpen: () => SettingsMessage.OpenedVisibility(),
              RequestedClose: () => SettingsMessage.ClosedVisibility(),
              Picked: ({ value }) => {
                const next =
                  value === "public" || value === "internal"
                    ? value
                    : "private";
                return SettingsMessage.PickedVisibility({
                  visibility: next,
                  source: "user",
                });
              },
              Settled: () => undefined,
            },
            view: (select) =>
              field
                .root(h.div)
                .children(
                  select.label(h.div).children("Visibility"),
                  field
                    .focusWithin(h.div)
                    .children(
                      select
                        .trigger(field.member(h.button))
                        .children(select.value(h.span)),
                      select
                        .positioner(h.div)
                        .children(
                          select
                            .popup(h.div)
                            .children(
                              visibilityItems.map(({ label, value }) =>
                                select
                                  .item({ element: h.div, value })
                                  .children(
                                    select.itemText(h.div).children(label),
                                  ),
                              ),
                            ),
                        ),
                    ),
                ),
          }),
      }),
      h.label(
        Switch(h, {
          props: { checked: model.weeklyDigest },
          onToggle: ({ checked }) =>
            SettingsMessage.ToggledDigest({ checked, source: "user" }),
          view: (sw) => sw.root(h.button).children(sw.thumb(h.span)),
        }),
        "Weekly digest",
      ),
      Button(h, {
        props: { disabled: model.deleted },
        onPress: SettingsMessage.DeletedProject({ source: "user" }),
      }).children("Delete project"),
    ),
});

export const ProjectSettingsAgent = AgentBridge.expose(ProjectSettings, {
  label: "Project settings",
  hidden: (model) => model.showingRecoveryCodes,
  state: (model) => ({
    name: model.name,
    visibility: model.visibility,
    weeklyDigest: model.weeklyDigest,
    // Intentionally return the Redacted value here to prove AgentBridge scrubs it automatically
    apiKey: model.apiKey,
    hasApiKey: Redacted.value(model.apiKey).length > 0,
    deleted: model.deleted,
  }),
  actions: {
    setName: {
      description: "Rename the project",
      args: Schema.Struct({ name: Schema.String.check(Schema.isMinLength(1)) }),
      toMessage: ({ name }, { source }) =>
        SettingsMessage.UpdatedName({ name, source }),
    },
    setVisibility: {
      description: "Change project visibility",
      args: Schema.Struct({ visibility: Visibility }),
      toMessage: ({ visibility }, { source }) =>
        SettingsMessage.PickedVisibility({ visibility, source }),
    },
    setWeeklyDigest: {
      description: "Toggle the weekly email digest",
      args: Schema.Struct({ enabled: Schema.Boolean }),
      toMessage: ({ enabled }, { source }) =>
        SettingsMessage.ToggledDigest({ checked: enabled, source }),
    },
    setApiKey: {
      description: "Update the project API key (write-only secret)",
      secret: true,
      args: Schema.Struct({ apiKey: Schema.RedactedFromValue(Schema.String) }),
      toMessage: ({ apiKey }, { source }) =>
        SettingsMessage.UpdatedApiKey({ apiKey, source }),
    },
    deleteProject: {
      description: "Permanently delete the project and all its files",
      confirm: (model) => `Deletes "${model.name}" and all its files`,
      enabled: (model) => !model.deleted,
      args: Schema.Struct({}),
      toMessage: (_args, { source }) =>
        SettingsMessage.DeletedProject({ source }),
    },
  },
});
