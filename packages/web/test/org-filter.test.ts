import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, db, newUser } from "./helpers.js";

// `?org=<slug>` scopes the list endpoints to that org and is required; a slug the caller isn't in is a 404.

async function sharedOrg(...keys: string[]) {
  const id = randomUUID();
  const slug = `team-${id.slice(0, 8)}`;
  await db.query(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  for (const key of keys) {
    const me = (await call("GET", "/me", { key })).body;
    await db.query(`INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, 'test')`, [
      id,
      me.id,
    ]);
  }
  return { id, slug };
}

const personal = async (key: string) =>
  (await call("GET", "/orgs", { key })).body.data.find((o: { personal: boolean }) => o.personal).slug as string;

const LISTS = ["/inboxes", "/bots", "/runners", "/events", "/inboxes/activity", "/bots/activity"];

describe("the org filter on list endpoints", () => {
  it("shows only the named org's inboxes and bots", async () => {
    const key = await newUser();
    const team = await sharedOrg(key);
    const mine = await personal(key);
    const inTeam = (await call("POST", "/inboxes", { key, body: { org: team.slug, name: "t", source_type: "github" } }))
      .body;
    const inMine = (await call("POST", "/inboxes", { key, body: { org: mine, name: "m", source_type: "github" } }))
      .body;
    const bot = (org: string, inbox: string) =>
      call("POST", "/bots", { key, body: { org, name: org, model: "sonnet", harness: "claude", inbox_ids: [inbox] } });
    const botTeam = (await bot(team.slug, inTeam.id)).body;
    const botMine = (await bot(mine, inMine.id)).body;
    const ids = async (path: string) =>
      ((await call("GET", path, { key })).body.data as { id?: string; inbox_id?: string; bot_id?: string }[])
        .map((r) => r.id ?? r.inbox_id ?? r.bot_id)
        .sort();

    expect(await ids(`/inboxes?org=${team.slug}`)).toEqual([inTeam.id]);
    expect(await ids(`/inboxes?org=${mine}`)).toEqual([inMine.id]);
    expect(await ids(`/bots?org=${team.slug}`)).toEqual([botTeam.id]);
    expect(await ids(`/bots?org=${mine}`)).toEqual([botMine.id]);
    expect(await ids(`/inboxes/activity?org=${team.slug}`)).toEqual([inTeam.id]);
    expect(await ids(`/bots/activity?org=${mine}`)).toEqual([botMine.id]);
    for (const path of LISTS) expect((await call("GET", `${path}?org=${mine}`, { key })).status, path).toBe(200);
  });

  it("answers 400 org_required without an org, so no list mixes orgs", async () => {
    const key = await newUser();
    for (const path of LISTS) {
      const r = await call("GET", path, { key, noOrg: true });
      expect([r.status, r.body.error.code], path).toEqual([400, "org_required"]);
      expect((await call("GET", `${path}?org=`, { key, noOrg: true })).status, path).toBe(400);
    }
  });

  it("answers 404 for an org the caller isn't in, the same as for one that doesn't exist", async () => {
    const owner = await newUser("Owner");
    const stranger = await newUser("Stranger");
    const team = await sharedOrg(owner);
    for (const path of LISTS) {
      const foreign = await call("GET", `${path}?org=${team.slug}`, { key: stranger });
      const missing = await call("GET", `${path}?org=no-such-org`, { key: stranger });
      expect([foreign.status, foreign.body], path).toEqual([404, missing.body]);
      expect(missing.status, path).toBe(404);
    }
  });
});
