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
  } catch {}
}

export function clear() {
  try {
    localStorage.removeItem(KEY);
  } catch {}
}

export function api(path: string, { method = "GET", body, auth = true }: { method?: string; body?: unknown; auth?: boolean } = {}) {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["content-type"] = "application/json";
  const t = token();
  if (auth && t) headers.authorization = "Bearer " + t;
  return fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

export async function message(r: Response) {
  try {
    return (await r.json()).error.message as string;
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

/** The signed-in user, or null while loading. Sends anyone without a working token to /login. */
export function useMe() {
  const [me, setMe] = useState<Me | null>(null);
  useEffect(() => {
    if (!token()) return location.replace("/login");
    api("/me")
      .catch(() => null)
      .then(async (r) => {
        if (!r || !r.ok) return r && expired(r);
        setMe(await r.json());
      });
  }, []);
  return me;
}
