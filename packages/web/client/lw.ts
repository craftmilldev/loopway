import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { identify, reset, track } from "./metrics.js";

// Talks to the JSON API on the same origin with the session token kept in localStorage.

const KEY = "loopway_token";

export interface Me {
  id: string;
  email: string | null;
  name: string;
}

export function token() {
  try {
    return localStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function save(t: string) {
  try {
    localStorage.setItem(KEY, t);
  } catch {
    // Storage is blocked; the token just isn't kept.
  }
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {
    // Storage is blocked, so there's nothing to clear.
  }
}

export function api(
  path: string,
  { method = "GET", body, auth = true }: { method?: string; body?: unknown; auth?: boolean } = {},
) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const t = token();
  if (auth && t) headers.authorization = "Bearer " + t;
  return fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function message(r: Response) {
  try {
    return ((await r.json()) as { error: { message: string } }).error.message;
  } catch {
    return "Something went wrong (" + r.status + ").";
  }
}

// An expired or invalid token is dropped quietly and the user lands on the login page.
export function expired(r: Response) {
  if (r.status === 401) {
    clear();
    location.replace("/login");
  }
}

export function logout() {
  reset();
  clear();
  location.replace("/login");
}

/** A source type as `GET /sources` describes it. */
export interface Source {
  type: string;
  label: string;
  description: string;
  events: string[];
  secret: { from: "loopway"; min_length: number } | { from: "sender" };
  webhook_settings: string;
}

/** `GET /sources`: the source types, and whether this deployment takes requests for new ones. */
export interface Sources {
  data: Source[];
  can_request: boolean;
}

/** The source types, or null while loading. */
export function useSources() {
  const [sources, setSources] = useState<Sources | null>(null);
  useEffect(() => {
    void api("/sources").then(async (r) => {
      if (r.ok) setSources((await r.json()) as Sources);
    });
  }, []);
  return sources;
}

/** The signed-in user, or null while loading. Sends anyone without a working token to /login. */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!token()) return location.replace("/login");
    void api("/me")
      .catch(() => null)
      .then(async (r) => {
        if (!r || !r.ok) return r && expired(r);
        const me = (await r.json()) as Me;
        identify(me.id, { email: me.email, name: me.name });
        setMe(me);
      });
  }, []);
  return me;
}

/** A bot as `GET /bots` describes it. `leased_until` is null when no runner holds it. */
/** One assign rule of a bot (see @loopway/rules). */
export interface BotRule {
  types: string[];
  subject?: string;
  related?: string;
  action?: string;
}

/** One saved revision of a bot's prompt and rules. Rules are null for versions saved before bots had them. */
export interface BotVersion {
  version: number;
  prompt: string;
  rules: BotRule[] | null;
  created_at: string;
}

export interface Bot {
  id: string;
  name: string;
  model: string;
  prompt_version: BotVersion | null;
  inbox_ids: string[];
  cursor: number;
  runner_id: string | null;
  leased_until: string | null;
}

/** A runner as `GET /runners` describes it. `leased_until` is null when it is offline. */
export interface Runner {
  id: string;
  name: string;
  last_seen_at: string;
  leased_until: string | null;
  bots: { id: string; name: string }[];
  threads: number;
}

export interface ThreadMessage {
  id: string;
  inbox_id: string;
  type: string;
  subject: string | null;
  /** One line on what the message is; null when its source has none, and the UI shows the type instead. */
  summary: string | null;
}

export interface Thread {
  id: string;
  /** From the newest message that carries one (an issue or PR title); null if none does. */
  title: string | null;
  bot_id: string;
  status: "active" | "ended";
  started: boolean;
  interrupted: boolean;
  limited: boolean;
  runner_id: string | null;
  subjects: string[];
  waiting: ThreadMessage[];
  inflight: ThreadMessage[];
  delivered: number;
  /** Only from `GET /bots/:id/threads/:tid`. */
  delivered_messages?: {
    id: string;
    inbox_id: string;
    type: string;
    key: string | null;
    delivered_at: string | null;
    summary: string | null;
  }[];
  created_at: string;
  updated_at: string;
}

/** How often a visible page refreshes its data, and the longest a failing refresh waits before it tries again. */
export const POLL_MS = 15_000;
const MAX_BACKOFF_MS = 120_000;

/** True when `a` and `b` hold the same JSON, so a refresh that found nothing new can skip its state update. */
export const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

// When any load last succeeded. The "updated 12 s ago" label reads it without the pages re-rendering.
let updatedAt: number | null = null;
const updatedListeners = new Set<() => void>();
export function markUpdated() {
  updatedAt = Date.now();
  updatedListeners.forEach((l) => l());
}

/** When data was last loaded or refreshed, in ms since the epoch; null before the first load. */
export function useUpdatedAt() {
  return useSyncExternalStore(
    (l) => {
      updatedListeners.add(l);
      return () => void updatedListeners.delete(l);
    },
    () => updatedAt,
  );
}

// Every active poller, so one switch back to the tab refreshes them all and is counted once.
interface Poller {
  onVisible(): boolean;
}
const pollers = new Set<Poller>();
function onVisibility() {
  if (document.visibilityState !== "visible") return;
  let refreshed = false;
  for (const p of pollers) if (p.onVisible()) refreshed = true;
  if (refreshed) track("dashboard_refresh");
}

/**
 * Runs `refresh` every `interval` ms while `enabled` and the tab is visible (a window without focus still counts).
 * `refresh` resolves true on success. A failure doubles the wait, up to two minutes, and a success resets it.
 * Refreshes never overlap. When the tab becomes visible again it refreshes at once if the last success is older
 * than `interval`.
 */
export function usePoll(refresh: () => Promise<boolean>, enabled: boolean, interval: number | false = POLL_MS) {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    if (!enabled || interval === false) return;
    const every: number = interval;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let busy = false;
    let stopped = false;
    let delay = every;
    let last = Date.now();
    const hidden = () => document.visibilityState === "hidden";

    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped && !hidden()) timer = setTimeout(() => void run(), ms);
    };
    async function run() {
      clearTimeout(timer);
      if (stopped || hidden() || busy) return;
      busy = true;
      let ok = false;
      try {
        ok = await latest.current();
      } catch {
        // A network error is a failed refresh like any other.
      }
      busy = false;
      if (ok) last = Date.now();
      delay = ok ? every : Math.min(delay * 2, MAX_BACKOFF_MS);
      schedule(delay);
    }
    const poller: Poller = {
      onVisible() {
        if (busy) return false;
        const age = Date.now() - last;
        if (age >= every) {
          void run();
          return true;
        }
        schedule(Math.max(0, delay - age));
        return false;
      },
    };
    const onHide = () => {
      if (hidden()) clearTimeout(timer);
    };
    document.addEventListener("visibilitychange", onHide);
    if (pollers.size === 0) document.addEventListener("visibilitychange", onVisibility);
    pollers.add(poller);
    schedule(delay);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onHide);
      pollers.delete(poller);
      if (pollers.size === 0) document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled, interval]);
}

/**
 * GETs `path` once `ready`, and again whenever the returned `reload` is called. Null while loading or missing.
 * While the tab is visible it also refreshes every `poll` ms (`false` turns that off). A refresh keeps what is on
 * screen when it fails, and does not touch state when the response is unchanged.
 */
export function useGet<T>(path: string | null, ready: boolean, { poll = POLL_MS }: { poll?: number | false } = {}) {
  const [data, setData] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const seen = useRef<string | null>(null);

  const fetchOnce = useCallback(async () => {
    if (!path) return true;
    const r = await api(path);
    if (r.status === 404) {
      setMissing(true);
      return true;
    }
    if (!r.ok) {
      expired(r);
      return false;
    }
    const text = await r.text();
    markUpdated();
    if (text !== seen.current) {
      seen.current = text;
      setData(JSON.parse(text) as T);
    }
    return true;
  }, [path]);

  const reload = useCallback(async () => {
    await fetchOnce();
  }, [fetchOnce]);

  useEffect(() => {
    seen.current = null;
    if (ready) void reload();
  }, [ready, reload]);

  usePoll(
    async () => {
      try {
        const ok = await fetchOnce();
        if (!ok) track("dashboard_refresh_failed");
        return ok;
      } catch (err) {
        track("dashboard_refresh_failed");
        throw err;
      }
    },
    ready && !!path,
    poll,
  );
  return { data, missing, reload };
}

/** The `data` of a list endpoint. */
export function useList<T>(path: string | null, ready: boolean, options?: { poll?: number | false }) {
  const { data, ...rest } = useGet<{ data: T[] }>(path, ready, options);
  return { data: data?.data ?? null, ...rest };
}

/** One thing that happened to a thread, from `GET /events`. */
export interface ThreadEvent {
  id: string;
  kind: "created" | "started" | "ended" | "interrupted" | "limited" | "limit_cleared";
  at: string;
  bot_id: string;
  bot_name: string;
  thread_id: string;
  subjects: string[];
  title: string | null;
}

/** What a bot delivered, from `GET /bots/activity` (a list) or `GET /bots/:id/activity`. */
export interface BotActivity {
  bot_id: string;
  /** Oldest first, one per UTC day. */
  days: { date: string; delivered: number }[];
  delivered: number;
  last_delivery_at: string | null;
  runs: number;
  median_wait_seconds: number | null;
}

/** What an inbox received, from `GET /inboxes/activity` (a list) or `GET /inboxes/:id/activity`. */
export interface InboxActivity {
  inbox_id: string;
  /** Oldest first, one per UTC day. */
  days: { date: string; received: number }[];
  received: number;
  /** Messages ever received. */
  messages: number;
  last_message_at: string | null;
}

/** An inbox's days in the shape `DeliveryBars` draws. */
export const barDays = (a: InboxActivity | undefined) =>
  a && { days: a.days.map((d) => ({ date: d.date, delivered: d.received })) };

/** "5 min ago" for a time in the past; "never" for null. */
export function ago(iso: string | null, now = Date.now()) {
  if (!iso) return "never";
  const s = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return Math.floor(s / 60) + " min ago";
  if (s < 86_400) return Math.floor(s / 3600) + " h ago";
  return Math.floor(s / 86_400) + " d ago";
}

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

/** A GitHub link for a subject that looks like `owner/repo#N`, else null. */
export function subjectUrl(subject: string) {
  const m = subject.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
}

/** The models a bot may run on (src/models.ts): aliases for the latest of a family, then full ids to pin one. */
export const BOT_MODELS = [
  "sonnet",
  "opus",
  "fable",
  "haiku",
  "claude-fable-5-1",
  "claude-opus-5-5",
  "claude-sonnet-5-5",
  "claude-haiku-5-5",
];
