/**
 * Org slugs, which are also usernames, that nobody may take: the app's own paths and its marketing pages. This
 * file is covered by CODEOWNERS (.github/CODEOWNERS). Before adding a name, a person has to confirm that no existing
 * org or user already holds it, because reserving it later doesn't remove them.
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
]);
