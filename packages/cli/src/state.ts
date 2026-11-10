import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Subject } from "./source.js";

/** What loopway remembers between runs, in `<home>/state.json`. */
export interface State {
  /** Per repo, the creation time discovery has reached. A repo seen for the first time starts at "now". */
  repos: Record<string, { since: string }>;
  /** Every known subject, with the update ids already printed and the source's cursor for it. */
  subjects: Record<string, { subject: Subject; version?: string; seen: string[] }>;
}

export const emptyState = (): State => ({ repos: {}, subjects: {} });

export async function loadState(home: string): Promise<State> {
  let text: string;
  try {
    text = await readFile(join(home, "state.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
  const raw = JSON.parse(text) as Partial<State>;
  return { repos: raw.repos ?? {}, subjects: raw.subjects ?? {} };
}

export const saveState = (home: string, state: State) => writeJson(join(home, "state.json"), state);

/** Writes beside the file and renames, so a crash never leaves half a file. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await rename(file + ".tmp", file);
}
