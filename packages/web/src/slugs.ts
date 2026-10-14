/**
 * Org slugs, which are also usernames: a user's personal org has their username as its slug, so both share one
 * namespace. Add paths and marketing pages to RESERVED_SLUGS as they are claimed.
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
]);

export const SLUG_MIN = 2;
export const SLUG_MAX = 39;

export type SlugProblem = "too_short" | "too_long" | "invalid_chars" | "edge_hyphen" | "reserved";

/** Lowercase `[a-z0-9-]`, 2-39 characters, no leading or trailing `-`, not reserved. Undefined when it's fine. */
export function slugProblem(slug: string): SlugProblem | undefined {
  if (slug.length < SLUG_MIN) return "too_short";
  if (slug.length > SLUG_MAX) return "too_long";
  if (!/^[a-z0-9-]+$/.test(slug)) return "invalid_chars";
  if (slug.startsWith("-") || slug.endsWith("-")) return "edge_hyphen";
  if (RESERVED_SLUGS.has(slug)) return "reserved";
  return undefined;
}

export const SLUG_PROBLEM_MESSAGES: Record<SlugProblem, string> = {
  too_short: `Usernames are at least ${SLUG_MIN} characters`,
  too_long: `Usernames are at most ${SLUG_MAX} characters`,
  invalid_chars: "Usernames use only lowercase letters, numbers and hyphens",
  edge_hyphen: "Usernames can't start or end with a hyphen",
  reserved: "That username is reserved",
};

/** Squeezes arbitrary text (an email's local part) into slug characters: lowercased, other runs become `-`, trimmed. */
export function sanitizeSlug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX - 5) // room for a numeric suffix
    .replace(/-+$/, "");
}
