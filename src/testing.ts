import type { AgentBridge, SnapshotAction, SnapshotEntry } from "./AgentBridge.js"

export type ActionSelector = {
  readonly action: SnapshotAction["name"]
  readonly includeHidden?: boolean | undefined
} & (
  | (Pick<SnapshotEntry, "label"> & { readonly ref?: never })
  | (Pick<SnapshotEntry, "ref"> & { readonly label?: never })
)

const assertMatchCount = (
  bridge: Pick<AgentBridge, "snapshot">,
  { action, label, ref, includeHidden }: ActionSelector,
  expected: 0 | 1
): void => {
  const field = ref === undefined ? "label" : "ref"
  const target = ref ?? label
  if (typeof action !== "string" || typeof target !== "string" || (label !== undefined && ref !== undefined)) {
    throw new TypeError("An action selector requires an action name and exactly one label or ref.")
  }

  let matches = 0
  for (const entry of bridge.snapshot({ includeHidden: includeHidden ?? false })) {
    if (entry[field] === target) {
      matches += entry.actions.filter(({ name }) => name === action).length
    }
  }

  if (matches === expected) return

  const problem = expected === 0 ? "Unexpected exposure" : matches === 0 ? "Missing action" : "Ambiguous action"
  const expectation = expected === 0 ? "no advertised matches" : "one advertised match"
  throw new Error(`${problem}: expected ${expectation} by exact ${field}; found ${matches}.`)
}

export const assertActionDiscoverable = (bridge: Pick<AgentBridge, "snapshot">, selector: ActionSelector): void =>
  assertMatchCount(bridge, selector, 1)

export const assertActionNotDiscoverable = (bridge: Pick<AgentBridge, "snapshot">, selector: ActionSelector): void =>
  assertMatchCount(bridge, selector, 0)
