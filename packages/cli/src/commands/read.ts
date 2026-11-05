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
  if (!m) return value;
  const then = now - Number(m[1]) * UNITS[m[2]!]!;
  if (then < 0) throw new UsageError(`--since ${value} is before 1970`);
  return new Date(then).toISOString();
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
  // A compiled CommonJS `export default` arrives here as `{default: {default: fn}}`.
  const reader = (loaded.default as { default?: unknown } | undefined)?.default ?? loaded.default;
  if (typeof reader !== "function") {
    throw new UsageError(`${path} must have a default export: a function that takes a message`);
  }
  return { reader: reader as Reader, file };
}

/**
 * The cursor's file: named by everything that makes this read a different read. `--since` only moves it. Moving or
 * renaming a reader makes it a new reader, and a new reader starts from now.
 */
function cursorFile(ctx: Context, parts: (string | undefined)[]) {
  const name = createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 32);
  return join(ctx.configDir, "cursors", `${name}.json`);
}

async function readCursor(file: string): Promise<Cursor | undefined> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (err) {
    // Only a cursor that isn't there means a new reader. One we can't read must not be replaced with "now".
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UsageError(`Can't read the cursor in ${file}: ${(err as Error).message}`);
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

/** What a reader threw, as text. It can throw anything, including what `String` can't print. */
function describeThrown(thrown: unknown): string {
  if (thrown instanceof Error) return thrown.message;
  try {
    return String(thrown);
  } catch {
    return "something that can't be printed";
  }
}

/** Thrown when a reader's function throws. The cursor is left on that message, so it comes again. */
export class ReaderError extends Error {
  constructor(
    readonly message_id: string,
    cause: unknown,
  ) {
    super(`The reader failed on message ${message_id}: ${describeThrown(cause)}`, { cause });
  }
}

interface Run {
  ctx: Context;
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
  const { ctx, client, reader, file, cursorPath, type, signal } = run;
  const readerCtx: ReaderContext = { push: (m) => client.pushMessage(m), signal };
  let delivered = 0;
  for (;;) {
    const page = await client.readMessages({
      since: run.cursor.since,
      after: run.cursor.after ?? undefined,
      limit: PAGE_SIZE,
      type,
    });
    if (BigInt(run.cursor.since) < BigInt(page.retained_from!)) {
      ctx.err?.(
        `This cursor is older than the inbox keeps messages, so anything before ${page.retained_from} is gone.`,
      );
    }
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
    const next = { since: page.next_since!, after: page.next_after ?? null };
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
  const cursorPath = cursorFile(ctx, [file, api_url.replace(/\/+$/, ""), me.id, opts.type]);
  const saved = opts.since === undefined ? await readCursor(cursorPath) : undefined;
  let cursor = saved;
  if (!cursor) {
    // The server says what the start is, and whether it's a time at all, before the saved cursor is touched: a --since
    // it refuses must leave a reader where it was. Saved before anything is delivered, so a reader that throws on its
    // first message resumes from here.
    const since = opts.since === undefined ? "now" : sinceValue(opts.since);
    cursor = { since: (await client.readMessages({ since, limit: 1 })).since!, after: null };
    await writeCursor(cursorPath, file, cursor);
  }
  const run: Run = { ctx, client, reader, file, cursorPath, cursor, type: opts.type, signal };
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
    const stop = () => (clearTimeout(timer), done());
    const timer = setTimeout(() => (signal.removeEventListener("abort", stop), done()), ms);
    signal.addEventListener("abort", stop, { once: true });
  });

/** What a poll can't get past by waiting: it needs a person. */
const fatal = (err: unknown) =>
  err instanceof UsageError ||
  (err instanceof ApiError && err.status >= 400 && err.status < 500 && err.status !== 408 && err.status !== 429);

/**
 * `loopway poll`: `read`, again and again, until stopped. A reader that throws, or a server that can't be reached, is
 * tried again from the same message after a pause, since that's what the next read would do. Polling slows down to
 * once a minute when quiet, and goes back to `interval` when there's something to read.
 */
export async function poll(ctx: Context, path: string, opts: PollOptions, signal: AbortSignal, sleep = wait) {
  const fastest = opts.interval ?? DEFAULT_INTERVAL;
  const slowest = Math.max(MAX_INTERVAL, fastest);
  let delay = fastest;
  let run: Run | undefined;
  while (!signal.aborted) {
    try {
      if (!run) {
        const prepared = await prepare(ctx, path, opts, signal);
        run = prepared.run;
        if (prepared.started)
          ctx.err?.("First read of this reader: starting from now. Use --since to go further back.");
      }
      const delivered = await drain(run);
      delay = delivered ? fastest : Math.min(delay * 2, slowest);
    } catch (err) {
      if (fatal(err)) throw err;
      ctx.err?.(err instanceof Error ? err.message : String(err));
      delay = Math.min(delay * 2, slowest);
    }
    await sleep(delay * 1000, signal);
  }
}
