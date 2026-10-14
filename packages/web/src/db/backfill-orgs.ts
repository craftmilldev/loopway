import { uuidv7 } from "../ids.js";
import { sanitizeSlug, slugProblem } from "../slugs.js";
import type { Db } from "./index.js";

type Q = Pick<Db, "query">;

/** The user who goes by `mcwhittemore` and also belongs to the `craftmill` org. A no-op where they don't exist. */
const FOUNDER_EMAIL = "matthew@craftmill.dev";
const FOUNDER_USERNAME = "mcwhittemore";
const FOUNDER_ORG = "craftmill";

/**
 * Gives every user without one a personal org named after their email's local part (sanitized, with a numeric suffix
 * on a collision or reserved word) and a membership in it. Safe to run again: it only touches users with no personal
 * org. Also makes the founder's `craftmill` org when that user exists.
 */
export async function backfillOrgs(db: Q): Promise<void> {
  const taken = new Set((await db.query<{ slug: string }>(`SELECT slug FROM loopway.orgs`)).map((r) => r.slug));
  const users = await db.query<{ id: string; name: string; email: string | null }>(
    `SELECT u.id, u.name, u.email FROM loopway.users u
     WHERE NOT EXISTS (SELECT 1 FROM loopway.orgs o WHERE o.personal_user_id = u.id)
     ORDER BY (lower(u.email) = $1) DESC NULLS LAST, u.created_at, u.id`,
    [FOUNDER_EMAIL],
  );

  const add = async (slug: string, personalUserId: string | null, memberId: string) => {
    taken.add(slug);
    const orgId = uuidv7();
    await db.query(`INSERT INTO loopway.orgs (id, slug, name, personal_user_id) VALUES ($1, $2, $2, $3)`, [
      orgId,
      slug,
      personalUserId,
    ]);
    await db.query(`INSERT INTO loopway.org_members (org_id, user_id) VALUES ($1, $2)`, [orgId, memberId]);
  };

  for (const u of users) {
    const founder = u.email?.toLowerCase() === FOUNDER_EMAIL;
    if (founder && !taken.has(FOUNDER_ORG)) await add(FOUNDER_ORG, null, u.id);
    const base = founder ? FOUNDER_USERNAME : sanitizeSlug((u.email ?? u.name).split("@")[0]!) || "user";
    let slug = base;
    for (let n = 2; taken.has(slug) || slugProblem(slug); n++) slug = `${base}${n}`;
    await add(slug, u.id, u.id);
  }
}
