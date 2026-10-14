import { MARKETING_PATHS, marketingSlugs } from "./marketing.js";

/**
 * Org slugs, which are also usernames: a user's personal org has their username as its slug, so both share one
 * namespace. Add the app's own paths to RESERVED_SLUGS as they are claimed; marketing pages (src/marketing.ts) are
 * added automatically.
 */
export const RESERVED_SLUGS: ReadonlySet<string> = new Set([
  "api",
  "dashboard",
  "auth",
  "health",
  "webhooks",
  "login",
  "signup",
  "settings",
  "about",
  "pricing",
  "blog",
  "docs",
  "help",
  "support",
  "terms",
  "privacy",
  "new",
  "orgs",
  "me",
  "loopway",
  ...marketingSlugs(MARKETING_PATHS),
]);

export const SLUG_MIN = 2;
export const SLUG_MAX = 39;

/** Why a slug can't be used. `taken` isn't something slugProblem can see: it takes the database (see usernameProblem). */
export type SlugProblem = "too_short" | "too_long" | "invalid_chars" | "edge_hyphen" | "reserved" | "taken";

/** Lowercase `[a-z0-9-]`, 2-39 characters, no leading or trailing `-`, not reserved. Undefined when it's fine. */
export function slugProblem(slug: string): Exclude<SlugProblem, "taken"> | undefined {
  if (slug.length < SLUG_MIN) return "too_short";
  if (slug.length > SLUG_MAX) return "too_long";
  if (!/^[a-z0-9-]+$/.test(slug)) return "invalid_chars";
  if (slug.startsWith("-") || slug.endsWith("-")) return "edge_hyphen";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return undefined;
}

export const USERNAME_PROBLEM_MESSAGES: Record<SlugProblem, string> = {
  too_short: `Usernames are at least ${SLUG_MIN} characters`,
  too_long: `Usernames are at most ${SLUG_MAX} characters`,
  invalid_chars: "Usernames use only lowercase letters, numbers and hyphens",
  edge_hyphen: "Usernames can't start or end with a hyphen",
  reserved: "That username is reserved",
  taken: "That username is taken",
};
