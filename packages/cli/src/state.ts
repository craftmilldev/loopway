import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Subject } from "./source.js";

/** What loopway remembers between runs, in `<stateDir>/state.json`. */
export interface State {
  /** Per repo, the creation time discovery has reached. A repo seen for the first time starts at "now". */
  repos: Record<string, { since: string }>;
  /** Every known subject, with the update ids already printed and the source's cursor for it. */
  subjects: Record<string, { subject: Subject; version?: string; seen: string[] }>;
}

/**
 * Where a project keeps its state: `<project>/.loopway/state`, or `$LOOPWAY_STATE`. Every state path (cursors, threads,
 * session logs) is built from this, so two projects never see each other's threads.
 */
export const stateDir = (projectDir: string, env: NodeJS.ProcessEnv = process.env) =>
  env.LOOPWAY_STATE || join(projectDir, ".loopway", "state");

export const emptyState = (): State => ({ repos: {}, subjects: {} });

export async function loadState(dir: string): Promise<State> {
  let text: string;
  try {
    text = await readFile(join(dir, "state.json"), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return emptyState();
    throw err;
  }
  const raw = JSON.parse(text) as Partial<State>;
  return { repos: raw.repos ?? {}, subjects: raw.subjects ?? {} };
}

export const saveState = (dir: string, state: State) => writeState(dir, "state.json", state);

/** Writes a file under the state directory, which ignores itself in git (a `.gitignore` of `*`) from the first write. */
export async function writeState(dir: string, name: string, value: unknown): Promise<void> {
  await ignoreSelf(dir);
  await writeJson(join(dir, name), value);
}

async function ignoreSelf(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(join(dir, ".gitignore"), "*\n", { flag: "wx" }).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== "EEXIST") throw err;
  });
}

/** Writes beside the file and renames, so a crash never leaves half a file. */
export async function writeJson(file: string, value: unknown): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file + ".tmp", JSON.stringify(value, null, 2) + "\n");
  await rename(file + ".tmp", file);
}
