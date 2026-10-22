import type { ChangeKind } from "./chat-changes.js";

/** What a chat's thread is labelled with: `generic` if it changed no bot or inbox, else its most frequent change. */
export interface ChatLabel {
  label: "generic" | ChangeKind;
  /** How many approved changes of each kind ran; kinds that didn't run are left out. */
  actions: Partial<Record<ChangeKind, number>>;
}

/**
 * The label for a chat from the changes it made, in the order they ran. Only changes that succeeded count. The most
 * frequent kind wins; a tie goes to the kind done first.
 */
export function chatLabel(changes: readonly { kind: ChangeKind; ok: boolean }[]): ChatLabel {
  const actions: Partial<Record<ChangeKind, number>> = {};
  for (const { kind, ok } of changes) if (ok) actions[kind] = (actions[kind] ?? 0) + 1;
  // Object keys come back in insertion order, so the kinds are visited in the order they first ran: the tie-break.
  let label: ChatLabel["label"] = "generic";
  let best = 0;
  for (const kind of Object.keys(actions) as ChangeKind[])
    if (actions[kind]! > best) [label, best] = [kind, actions[kind]!];
  return { label, actions };
}
