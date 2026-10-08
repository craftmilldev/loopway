import { useEffect, useState } from "react";

// Talks to the JSON API on the same origin with the session token kept in localStorage.

const KEY = "loopway_token";

export interface Me {
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
  clear();
  location.replace("/login");
}

/** A source type as `GET /sources` describes it. */
export interface Source {
  type: string;
  label: string;
  description: string;
  events: string[];
  secret: { from: "loopway"; min_length: number } | { from: "sender" } | { from: "none" };
  webhook_settings: string;
}

/** The source types, or null while loading. */
export function useSources() {
  const [sources, setSources] = useState<Source[] | null>(null);
  useEffect(() => {
    void api("/sources").then(async (r) => {
      if (r.ok) setSources(((await r.json()) as { data: Source[] }).data);
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
        setMe((await r.json()) as Me);
      });
  }, []);
  return me;
}
