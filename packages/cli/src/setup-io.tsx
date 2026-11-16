import { Box, render, Static, Text, useInput } from "ink";
import { useEffect, useState } from "react";
import { runInherited, type Io } from "./setup.js";
import { editInput, emptyInput, InputLine, type InputState } from "./tui-input.js";
import { theme } from "./tui-theme.js";

const MARKS = { ok: "✓", warn: "!", fail: "✗" } as const;

/** What is being asked: a choice from a list, or a line of text (dots, for a secret). */
export type Question =
  | { kind: "choose"; question: string; options: { value: string; label: string }[] }
  | { kind: "text"; question: string; initial?: string; secret?: boolean };

/** The choices, as drawn: the one at `at` is marked. */
export function Choose({ question, options, at }: { question: string; options: { label: string }[]; at: number }) {
  return (
    <Box flexDirection="column">
      <Text color={theme.land}>? {question}</Text>
      {options.map((o, i) => (
        <Text key={o.label} color={i === at ? theme.red : undefined}>
          {i === at ? "❯ " : "  "}
          {o.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ to move, Enter to choose</Text>
    </Box>
  );
}

/** The line being typed, as drawn: a secret shows as dots of the same length, so editing behaves as with text. */
export function Prompt({ question, input, secret }: { question: string; input: InputState; secret?: boolean }) {
  const shown = secret ? { ...input, value: "•".repeat(input.value.length) } : input;
  return (
    <Box flexDirection="column">
      <Text color={theme.land}>? {question}</Text>
      <Box>
        <Text color={theme.red}>❯ </Text>
        <InputLine state={shown} width={Math.max(20, (process.stdout.columns ?? 80) - 4)} />
      </Box>
    </Box>
  );
}

/** What the screen shows: the lines said so far, and the question being asked, if any. */
class Store {
  lines: { id: number; text: string }[] = [];
  question?: Question;
  answer?: (value: string) => void;
  private listeners = new Set<() => void>();
  subscribe(fn: () => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  change(fn: () => void) {
    fn();
    for (const l of this.listeners) l();
  }
  /** A new array each time: `Static` only looks again when it gets a different one. */
  say(text: string) {
    this.change(() => (this.lines = [...this.lines, { id: this.lines.length, text }]));
  }
}

/**
 * One app for the whole walk, with one `useInput` for the whole of it. Questions that came and went each with their
 * own `useInput` dropped the terminal out of raw mode between them, and a token typed then was echoed as plain text.
 */
function Screen({ store }: { store: Store }) {
  const [, tick] = useState(0);
  const [at, setAt] = useState(0);
  const [input, setInput] = useState<InputState>(emptyInput);
  useEffect(() => store.subscribe(() => tick((n) => n + 1)), [store]);
  const q = store.question;
  // A new question starts at its first choice, or its initial text.
  useEffect(() => {
    setAt(0);
    const initial = q?.kind === "text" ? (q.initial ?? "") : "";
    setInput({ value: initial, cursor: initial.length });
  }, [q]);
  useInput((typed, key) => {
    if (!q || !store.answer) return;
    if (q.kind === "choose") {
      if (key.upArrow) setAt((i) => Math.max(0, i - 1));
      else if (key.downArrow) setAt((i) => Math.min(q.options.length - 1, i + 1));
      else if (key.return) store.answer(q.options[at]!.value);
    } else if (key.return) store.answer(input.value);
    else setInput((s) => editInput(s, typed, key));
  });
  return (
    <>
      <Static items={store.lines}>{(line) => <Text key={line.id}>{line.text}</Text>}</Static>
      {q?.kind === "choose" && <Choose question={q.question} options={q.options} at={at} />}
      {q?.kind === "text" && <Prompt question={q.question} input={input} secret={q.secret} />}
    </>
  );
}

/**
 * The real terminal for `loopway setup`: Ink for the questions, with the lines said above them. `close` ends it.
 */
export function inkIo(): Io & { close: () => Promise<void> } {
  let store = new Store();
  let app: ReturnType<typeof render> | undefined;
  const open = () => (app ??= render(<Screen store={store} />));
  const ask = (question: Question) => {
    open();
    return new Promise<string>((resolve) => {
      store.change(() => {
        store.question = question;
        store.answer = (value) => {
          // The answered question stays on screen as a line.
          store.say(
            `? ${question.question} ${question.kind === "text" && question.secret ? "•".repeat(value.length) : value}`,
          );
          store.change(() => {
            store.question = undefined;
            store.answer = undefined;
          });
          resolve(value);
        };
      });
    });
  };
  const close = async () => {
    const current = app;
    app = undefined;
    current?.unmount();
    await current?.waitUntilExit();
  };
  return {
    say: (line, tone) => {
      open();
      store.say(tone ? `${MARKS[tone]} ${line}` : line);
    },
    choose: ((question, options) => ask({ kind: "choose", question, options })) as Io["choose"],
    text: (question, initial) => ask({ kind: "text", question, initial }),
    secret: (question) => ask({ kind: "text", question, secret: true }),
    // gh auth login asks its own questions: give it the terminal, and start again after it, with a clean screen.
    run: async (command, args) => {
      await close();
      store = new Store();
      return runInherited(command, args);
    },
    close,
  };
}
