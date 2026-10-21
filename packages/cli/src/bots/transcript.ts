import { getHarness, type TranscriptLine } from "@loopway/harnesses";
import { join } from "node:path";

/** Where a thread's transcript goes: ~/.loopway/threads/<thread>.log */
export const sessionLogPath = (dir: string, threadId: string) => join(dir, "threads", `${threadId}.log`);

export type { TranscriptLine };

/** A thread's transcript, read the way the harness its bot runs on writes its log. */
export function transcriptLines(log: string, harness: string): TranscriptLine[] {
  return getHarness(harness).transcript(log);
}

/** Splits text into rows of at most `width` characters, at newlines and then at spaces where it can. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(1, width);
  return text.split("\n").flatMap((line) => {
    const rows: string[] = [];
    while (line.length > w) {
      const space = line.lastIndexOf(" ", w);
      const cut = space > 0 ? space : w;
      rows.push(line.slice(0, cut));
      line = line.slice(space > 0 ? cut + 1 : cut);
    }
    return [...rows, line];
  });
}
