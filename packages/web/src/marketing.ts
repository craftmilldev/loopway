/**
 * The marketing pages: the paths served by the marketing site, `/` being the home. Each needs a markdown file in
 * content/ registered in client/marketing.tsx (the compiler checks that it is). A page's first path segment must
 * also be in RESERVED_SLUGS (slugs.ts) before it ships, once no org holds that name; a test checks it is.
 */
export const MARKETING_PATHS = ["/"] as const;

export type MarketingPath = (typeof MARKETING_PATHS)[number];
