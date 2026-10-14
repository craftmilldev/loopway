/**
 * The marketing pages: the paths served by the marketing site, `/` being the home. Each needs a markdown file in
 * content/ registered in client/marketing.tsx (the compiler checks that it is). A page's first path segment must
 * also be in reserved-slugs.ts (a test checks it is). Don't add one there on your own: an org may already hold the
 * name, so have a user confirm the change first.
 */
export const MARKETING_PATHS = ["/"] as const;

export type MarketingPath = (typeof MARKETING_PATHS)[number];
