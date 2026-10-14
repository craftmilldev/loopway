/**
 * The marketing pages: the paths served by the marketing site, `/` being the home. Each needs a markdown file in
 * content/ registered in client/marketing.tsx (the compiler checks that it is). Every path's first segment is
 * reserved as an org slug (see slugs.ts), so a page can't be shadowed by an org.
 */
export const MARKETING_PATHS = ["/"] as const;

export type MarketingPath = (typeof MARKETING_PATHS)[number];

/** The org slugs that marketing paths take: the first segment of each path (the home, `/`, takes none). */
export function marketingSlugs(paths: readonly string[]): string[] {
  return paths.map((p) => p.split("/")[1]!).filter(Boolean);
}
