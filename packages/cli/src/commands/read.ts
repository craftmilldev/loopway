import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { ApiError, type LoopwayClient, type Message, type PushInput } from "../client.js";
import { loadConfig } from "../config.js";
import { authedClient, UsageError, type Context } from "../context.js";

/** What a reader gets: the CloudEvent, flattened, with when loopway received it and its message id. */
export interface ReaderMessage extends Record<string, unknown> {
  id: string;
  type: string;
  source: string;
  message_id: string;
  /** ISO 8601, to the microsecond. Give it to `--since` to go back to this message. */
  received_at: string;
  received_us: string;
}

export interface ReaderContext {
  /** Puts a message in the same inbox. */
  push(message: PushInput): Promise<{ id: string; duplicate: boolean }>;
  /** Aborts when the command is stopping, for a reader doing something slow. */
  signal: AbortSignal;
}

export type Reader = (message: ReaderMessage, ctx: ReaderContext) => unknown;

/** Where a reader has got to. `after` is a message id at exactly `since`, the one to carry on past. */
interface Cursor {
  since: string;
  after: string | null;
}

export interface ReadOptions {
  since?: string;
  type?: string;
}

export interface PollOptions extends ReadOptions {
  /** Seconds between polls after activity. */
  interval?: number;
}

const PAGE_SIZE = 100;
const DEFAULT_INTERVAL = 5;
/** The slowest a quiet poll or a failing reader gets. */
const MAX_INTERVAL = 60;

const UNITS: Record<string, number> = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };

/** A `--since`, as the API takes it. `2h` and `3d` are that long ago; anything else goes as it is, and the API checks it. */
export function sinceValue(value: string, now = Date.now()): string {
  const m = /^(\d+)([smhd])$/.exec(value);
  return m ? new Date(now - Number(m[1]) * UNITS[m[2]!]!).toISOString() : value;
}

/** A reader's file on disk, loaded. Its default export is called once per message. */
async function loadReader(path: string): Promise<{ reader: Reader; file: string }> {
  let file: string;
  try {
    file = await realpath(resolve(path));
  } catch {
    throw new UsageError(`No reader at ${path}`);
  }
  let loaded: { default?: unknown };
  try {
    loaded = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (err) {
    throw new UsageError(`Could not load ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof loaded.default !== "function") {
    throw new UsageError(`${path} must have a default export: a function that takes a message`);
  }
  return { reader: loaded.default as Reader, file };
}

/** The cursor's file: named by everything that makes this read a different read. `--since` only moves it. */
function cursorFile(ctx: Context, parts: (string | undefined)[]) {
  const name = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return join(ctx.configDir, "cursors", `${name}.json`);
}

async function readCursor(file: string): Promise<Cursor | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return undefined;
  }
  try {
    const { since, after } = JSON.parse(text) as Partial<Cursor>;
    if (typeof since !== "string") throw new Error();
    return { since, after: typeof after === "string" ? after : null };
  } catch {
    throw new UsageError(`Can't read the cursor in ${file}. Delete it, or pick a time with --since.`);
  }
}

/** Replaces the file in one step, so a crash mid-write can't leave half a cursor. */
async function writeCursor(file: string, reader: string, cursor: Cursor) {
  await mkdir(join(file, ".."), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ reader, ...cursor }) + "\n");
  await rename(tmp, file);
}

const toReaderMessage = (m: Message): ReaderMessage => ({
  ...m.event,
  message_id: m.id,
  received_at: m.received_at,
  received_us: m.received_us,
});

/** Thrown when a reader's function throws. The cursor is left on that message, so it comes again. */
export class ReaderError extends Error {
  constructor(
    readonly message_id: string,
    cause: unknown,
  ) {
    super(`The reader failed on message ${message_id}: ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
  }
}

interface Run {
  client: LoopwayClient;
  reader: Reader;
  file: string;
  cursorPath: string;
  cursor: Cursor;
  type?: string;
  signal: AbortSignal;
}

/**
 * Hands the reader everything after the cursor, one message at a time and in order, moving the cursor past each one
 * only once the reader has finished with it. That order is the at-least-once guarantee: a crash between the two means
 * a repeat, never a loss. Returns how many it delivered.
 */
async function drain(run: Run): Promise<number> {
  const { client, reader, file, cursorPath, type, signal } = run;
  const readerCtx: ReaderContext = { push: (m) => client.pushMessage(m), signal };
  let delivered = 0;
  for (;;) {
    const page = await client.readMessages({
      since: run.cursor.since,
      after: run.cursor.after ?? undefined,
      limit: PAGE_SIZE,
      type,
    });
    for (const m of page.data) {
      if (signal.aborted) return delivered;
      try {
        await reader(toReaderMessage(m), readerCtx);
      } catch (err) {
        throw new ReaderError(m.id, err);
      }
      run.cursor = { since: m.received_us, after: m.id };
      await writeCursor(cursorPath, file, run.cursor);
      delivered++;
    }
    const next = { since: page.next_since!, after: page.next_after };
    if (next.since !== run.cursor.since || next.after !== run.cursor.after) {
      run.cursor = next;
      await writeCursor(cursorPath, file, run.cursor);
    }
    if (!page.has_more) return delivered;
  }
}

/** Loads the reader and finds where to start: --since, else the saved cursor, else now. */
async function prepare(ctx: Context, path: string, opts: ReadOptions, signal: AbortSignal) {
  const { reader, file } = await loadReader(path);
  const client = await authedClient(ctx);
  const { api_url } = await loadConfig(ctx.configDir, ctx.env);
  const me = await client.me();
  const cursorPath = cursorFile(ctx, [file, api_url, me.id, opts.type]);
  const saved = opts.since === undefined ? await readCursor(cursorPath) : undefined;
  let cursor = saved;
  if (!cursor) {
    const since = opts.since === undefined ? "now" : sinceValue(opts.since);
    // Named before anything is delivered: a reader that throws on its first message resumes from here, not from
    // wherever it was before --since. `now` has to ask the server: its clock and holdback decide where now is.
    const start = since === "now" ? (await client.readMessages({ since: "now", limit: 1 })).next_since! : since;
    cursor = { since: start, after: null };
    await writeCursor(cursorPath, file, cursor);
  }
  const run: Run = { client, reader, file, cursorPath, cursor, type: opts.type, signal };
  return { run, started: !saved && opts.since === undefined };
}

/** `loopway read`: everything since the last read, then exit. */
export async function read(ctx: Context, path: string, opts: ReadOptions, signal = new AbortController().signal) {
  const { run, started } = await prepare(ctx, path, opts, signal);
  if (started) ctx.err?.("First read of this reader: starting from now. Use --since to go further back.");
  const delivered = await drain(run);
  ctx.err?.(`Read ${delivered} message${delivered === 1 ? "" : "s"}.`);
}

const wait = (ms: number, signal: AbortSignal) =>
  new Promise<void>((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", () => (clearTimeout(timer), done()), { once: true });
  });

/** What a poll can't get past by waiting: it needs a person. */
const fatal = (err: unknown) =>
  err instanceof UsageError || (err instanceof ApiError && (err.status === 401 || err.status === 426));

/**
 * `loopway poll`: `read`, again and again, until stopped. A reader that throws, or a server that can't be reached, is
 * tried again from the same message after a pause, since that's what the next read would do. Polling slows down to
 * once a minute when quiet, and goes back to `interval` when there's something to read.
 */
export async function poll(ctx: Context, path: string, opts: PollOptions, signal: AbortSignal, sleep = wait) {
  const { run, started } = await prepare(ctx, path, opts, signal);
  if (started) ctx.err?.("First read of this reader: starting from now. Use --since to go further back.");
  const fastest = opts.interval ?? DEFAULT_INTERVAL;
  let delay = fastest;
  while (!signal.aborted) {
    try {
      const delivered = await drain(run);
      delay = delivered ? fastest : Math.min(delay * 2, Math.max(MAX_INTERVAL, fastest));
    } catch (err) {
      if (fatal(err)) throw err;
      ctx.err?.(err instanceof Error ? err.message : String(err));
      delay = Math.min(delay * 2, Math.max(MAX_INTERVAL, fastest));
    }
    await sleep(delay * 1000, signal);
  }
}
