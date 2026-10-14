import type { Context } from "hono";
import type { Db } from "./db/index.js";
import type { User } from "./store.js";

/** What the authenticated routes read from the Hono context. */
export type Env = { Variables: { db: Db; user: User } };

export class ApiError extends Error {
  constructor(
    public status: 400 | 401 | 403 | 404 | 409 | 415 | 422 | 426 | 500 | 502,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export async function jsonBody(c: Context): Promise<unknown> {
  const text = await c.req.text();
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json", "Request body must be JSON");
  }
}
