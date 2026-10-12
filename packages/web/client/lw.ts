import { useCallback, useEffect, useState } from "react";
import { identify, reset } from "./metrics.js";

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
  kind: string;
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
  bots: unknown[];
  threads: number;
}

export interface ThreadMessage {
  id: string;
  inbox_id: string;
  type: string;
  subject: string | null;
}

export interface Thread {
  id: string;
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
  }[];
  updated_at: string;
}

/** GETs `path` once `ready`, and again whenever the returned `reload` is called. Null while loading or missing. */
export function useGet<T>(path: string | null, ready: boolean) {
  const [data, setData] = useState<T | null>(null);
  const [missing, setMissing] = useState(false);
  const reload = useCallback(async () => {
    if (!path) return;
    const r = await api(path);
    if (r.status === 404) return setMissing(true);
    if (!r.ok) return expired(r);
    setData((await r.json()) as T);
  }, [path]);
  useEffect(() => {
    if (ready) void reload();
  }, [ready, reload]);
  return { data, missing, reload };
}

/** The `data` of a list endpoint. */
export function useList<T>(path: string | null, ready: boolean) {
  const { data, ...rest } = useGet<{ data: T[] }>(path, ready);
  return { data: data?.data ?? null, ...rest };
}

export const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString() : "never");

/** A GitHub link for a subject that looks like `owner/repo#N`, else null. */
export function subjectUrl(subject: string) {
  const m = subject.match(/^([\w.-]+\/[\w.-]+)#(\d+)$/);
  return m ? `https://github.com/${m[1]}/issues/${m[2]}` : null;
}

/** A starting point for a new bot (GET /presets). */
export interface Preset {
  kind: string;
  label: string;
  description: string;
}
