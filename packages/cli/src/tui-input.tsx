import { Text } from "ink";
import type { Key } from "ink";
import { theme } from "./tui-theme.js";

export interface InputState {
  value: string;
  /** Where the next character goes: 0 is before the first. */
  cursor: number;
}

export const emptyInput: InputState = { value: "", cursor: 0 };

/**
 * One key applied to a line being typed, like a text box: ←/→ move the cursor, Home/End (or Ctrl-A/Ctrl-E) jump to the
 * ends, Backspace removes the character before the cursor and Delete the one after, and anything else is inserted at
 * the cursor. Keys it doesn't use (Enter, Esc, ↑/↓) come back unchanged.
 */
export function editInput(state: InputState, input: string, key: Key): InputState {
  const { value, cursor } = state;
  if (key.leftArrow) return { value, cursor: Math.max(0, cursor - 1) };
  if (key.rightArrow) return { value, cursor: Math.min(value.length, cursor + 1) };
  if (key.home || (key.ctrl && input === "a")) return { value, cursor: 0 };
  if (key.end || (key.ctrl && input === "e")) return { value, cursor: value.length };
  if (key.backspace) {
    return cursor === 0 ? state : { value: value.slice(0, cursor - 1) + value.slice(cursor), cursor: cursor - 1 };
  }
  if (key.delete) return { value: value.slice(0, cursor) + value.slice(cursor + 1), cursor };
  if (key.ctrl || key.meta || key.tab || key.return || key.escape || key.upArrow || key.downArrow || !input) {
    return state;
  }
  return { value: value.slice(0, cursor) + input + value.slice(cursor), cursor: cursor + input.length };
}

/** The line with a block cursor, scrolled sideways so the cursor stays in view within `width` columns. */
export function InputLine({ state, width }: { state: InputState; width: number }) {
  const { value, cursor } = state;
  const room = Math.max(4, width - 1);
  const start = Math.max(0, cursor - room + 1);
  const shown = value.slice(start, start + room);
  const at = cursor - start;
  return (
    <Text>
      {shown.slice(0, at)}
      <Text backgroundColor={theme.cream} color={theme.ink}>
        {shown[at] ?? " "}
      </Text>
      {shown.slice(at + 1)}
    </Text>
  );
}
