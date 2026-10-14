import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { call, db, newUser } from "./helpers.js";

/** A shared org with the given users as members; returns its slug and id. */
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

const inboxBody = (org?: string) => ({ org, name: "gh", source_type: "github" });
const botBody = (inbox_ids: string[], org?: string) => ({
  org,
  name: "b",
  model: "sonnet",
  harness: "claude",
  inbox_ids,
});

describe("creating an inbox or bot picks its org", () => {
  it("answers 400 org_required without an org, and creates nothing", async () => {
    const key = await newUser();
    const inbox = await call("POST", "/inboxes", { key, noOrg: true, body: inboxBody() });
    expect([inbox.status, inbox.body.error.code]).toEqual([400, "org_required"]);
    const bot = await call("POST", "/bots", { key, noOrg: true, body: botBody([randomUUID()]) });
    expect([bot.status, bot.body.error.code]).toEqual([400, "org_required"]);
    expect((await call("GET", "/inboxes", { key })).body.data).toEqual([]);
    expect((await call("GET", "/bots", { key })).body.data).toEqual([]);
  });

  it("creates in the chosen org, shared or personal", async () => {
    const key = await newUser();
    const team = await sharedOrg(key);
    const mine = await personal(key);

    const inShared = await call("POST", "/inboxes", { key, body: inboxBody(team.slug) });
    expect([inShared.status, inShared.body.org_id]).toEqual([201, team.id]);
    const inPersonal = await call("POST", "/inboxes", { key, body: inboxBody(mine) });
    expect(inPersonal.status).toBe(201);
    expect(inPersonal.body.org_id).not.toBe(team.id);

    const bot = await call("POST", "/bots", { key, body: botBody([inShared.body.id], team.slug) });
    expect([bot.status, bot.body.org_id]).toEqual([201, team.id]);
  });

  it("answers 404 for an unknown org or one the caller isn't in, and creates nothing", async () => {
    const owner = await newUser("Owner");
    const stranger = await newUser("Stranger");
    const team = await sharedOrg(owner);

    for (const org of [team.slug, "no-such-org"]) {
      const inbox = await call("POST", "/inboxes", { key: stranger, body: inboxBody(org) });
      expect([inbox.status, inbox.body.error.code]).toEqual([404, "not_found"]);
      const bot = await call("POST", "/bots", { key: stranger, body: botBody([randomUUID()], org) });
      expect([bot.status, bot.body.error.code]).toEqual([404, "not_found"]);
    }
    expect((await call("GET", "/inboxes", { key: owner })).body.data).toEqual([]);
    expect((await call("GET", "/bots", { key: owner })).body.data).toEqual([]);
  });

  it("only attaches inboxes of the bot's own org", async () => {
    const key = await newUser();
    const team = await sharedOrg(key);
    const inTeam = (await call("POST", "/inboxes", { key, body: inboxBody(team.slug) })).body;
    const inMine = (await call("POST", "/inboxes", { key, body: inboxBody(await personal(key)) })).body;

    const wrong = await call("POST", "/bots", { key, body: botBody([inMine.id], team.slug) });
    expect([wrong.status, wrong.body.error.code]).toEqual([400, "inbox_org_mismatch"]);
    const wrongPersonal = await call("POST", "/bots", { key, body: botBody([inTeam.id], await personal(key)) });
    expect([wrongPersonal.status, wrongPersonal.body.error.code]).toEqual([400, "inbox_org_mismatch"]);
    expect((await call("GET", "/bots", { key })).body.data).toEqual([]);

    const bot = (await call("POST", "/bots", { key, body: botBody([inTeam.id], team.slug) })).body;
    const patch = await call("PATCH", `/bots/${bot.id}`, { key, body: { inbox_ids: [inMine.id] } });
    expect([patch.status, patch.body.error.code]).toEqual([400, "inbox_org_mismatch"]);
  });
});
