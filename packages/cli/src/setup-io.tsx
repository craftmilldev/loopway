import { Box, render, Text, useInput } from "ink";
import { useState } from "react";
import { runInherited, type Io } from "./setup.js";
import { editInput, InputLine, type InputState } from "./tui-input.js";
import { theme } from "./tui-theme.js";

/** Shows one question inline, waits for its answer, and leaves the answered line on screen. */
function ask<T>(element: (done: (value: T) => void) => React.ReactElement): Promise<T> {
  return new Promise((resolve) => {
    const app = render(
      element((value) => {
        app.unmount();
        resolve(value);
      }),
    );
  });
}

export function Choose({
  question,
  options,
  onDone,
}: {
  question: string;
  options: { value: string; label: string }[];
  onDone: (value: string) => void;
}) {
  const [at, setAt] = useState(0);
  const [answered, setAnswered] = useState(false);
  useInput((_, key) => {
    if (answered) return;
    if (key.upArrow) setAt((i) => Math.max(0, i - 1));
    if (key.downArrow) setAt((i) => Math.min(options.length - 1, i + 1));
    if (key.return) {
      setAnswered(true);
      onDone(options[at]!.value);
    }
  });
  if (answered) {
    return (
      <Text>
        <Text color={theme.land}>? </Text>
        {question} <Text color={theme.blue}>{options[at]!.label}</Text>
      </Text>
    );
  }
  return (
    <Box flexDirection="column">
      <Text color={theme.land}>? {question}</Text>
      {options.map((o, i) => (
        <Text key={o.value} color={i === at ? theme.red : undefined}>
          {i === at ? "❯ " : "  "}
          {o.label}
        </Text>
      ))}
      <Text dimColor>↑/↓ to move, Enter to choose</Text>
    </Box>
  );
}

export function Prompt({
  question,
  initial = "",
  secret,
  onDone,
}: {
  question: string;
  initial?: string;
  secret?: boolean;
  onDone: (value: string) => void;
}) {
  const [state, setState] = useState<InputState>({ value: initial, cursor: initial.length });
  const [answered, setAnswered] = useState(false);
  useInput((input, key) => {
    if (answered) return;
    if (key.return) {
      setAnswered(true);
      onDone(state.value);
    } else setState((s) => editInput(s, input, key));
  });
  // A token shows as dots, same length, so the cursor and editing behave as with text.
  const shown: InputState = secret ? { ...state, value: "•".repeat(state.value.length) } : state;
  if (answered) {
    return (
      <Text>
        <Text color={theme.land}>? </Text>
        {question} <Text color={theme.blue}>{secret ? "•".repeat(state.value.length) : state.value}</Text>
      </Text>
    );
  }
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

const MARKS = { ok: "✓", warn: "!", fail: "✗" } as const;

/** The real terminal for `loopway setup`: Ink for the questions, plain lines between them. */
export function inkIo(): Io {
  return {
    say: (line, tone) => console.log(tone ? `${MARKS[tone]} ${line}` : line),
    choose: <T extends string>(question: string, options: { value: T; label: string }[]) =>
      ask<T>((onDone) => <Choose question={question} options={options} onDone={(v) => onDone(v as T)} />),
    text: (question, initial) =>
      ask<string>((onDone) => <Prompt question={question} initial={initial} onDone={onDone} />),
    secret: (question) => ask<string>((onDone) => <Prompt question={question} secret onDone={onDone} />),
    run: runInherited,
  };
}
