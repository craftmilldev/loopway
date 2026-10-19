/**
 * Feature flags. Plain environment variables, so they work without PostHog; a flag is off unless its variable names an
 * org (a slug, or a comma-separated list of them) or turns it on for all orgs (`all`, `true` or `1`).
 */
export type OrgFlag = (orgSlug: string) => boolean;

export const flagOff: OrgFlag = () => false;

/** Reads a flag variable such as `FIRST_BOT_BY_CHAT=acme,bob`. Unset or empty is off for every org. */
export function parseOrgFlag(value: string | undefined): OrgFlag {
  const names = (value ?? "")
    .split(",")
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  if (names.some((n) => ["all", "true", "1"].includes(n))) return () => true;
  return (slug) => names.includes(slug.toLowerCase());
}
