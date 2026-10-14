import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { addOrgMember, createLoginCode } from "../src/store.js";
import { call, db, newInbox, newUser } from "./helpers.js";

async function me(key: string): Promise<{ id: string; email: string; username: string }> {
  return (await call("GET", "/me", { key })).body;
}

/** A shared org with these users as members. */
async function sharedOrg(...keys: string[]): Promise<string> {
  const id = randomUUID();
  const slug = `team-${id.slice(0, 8)}`;
  await db.query(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, $2, $2)`, [id, slug]);
  for (const key of keys)
    await db.query(`INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, 'test')`, [
      id,
      (await me(key)).id,
    ]);
  return slug;
}

async function signUp(email: string, username: string) {
  const { code } = await createLoginCode(db, email);
  return call("POST", "/auth/verify", { body: { email, code, username } });
}

describe("org members", () => {
  it("adds an existing user by email, who then reaches the org's entities", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const slug = await sharedOrg(a);
    const bUser = await me(b);

    const added = await call("POST", `/orgs/${slug}/members`, {
      key: a,
      body: { email: `  ${bUser.email.toUpperCase()} ` },
    });
    expect(added.status).toBe(201);
    expect(added.body.members.map((m: { id: string }) => m.id)).toContain(bUser.id);
    expect(added.body.pending).toEqual([]);

    const orgs = (await call("GET", "/orgs", { key: b })).body.data as { slug: string }[];
    expect(orgs.map((o) => o.slug)).toContain(slug);
    const inbox = await newInbox(a);
    await db.query(`UPDATE loopway.inboxes SET org_id = (SELECT id FROM loopway.orgs WHERE slug = $2) WHERE id = $1`, [
      inbox.id,
      slug,
    ]);
    expect((await call("GET", `/inboxes/${inbox.id}`, { key: b })).status).toBe(200);
  });

  it("lists members with usernames and emails, and pending emails", async () => {
    const a = await newUser("a");
    const slug = await sharedOrg(a);
    await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: "Later@Example.com" } });
    const list = await call("GET", `/orgs/${slug}/members`, { key: a });
    expect(list.status).toBe(200);
    const aUser = await me(a);
    expect(list.body).toEqual({
      members: [{ id: aUser.id, email: aUser.email, username: aUser.username }],
      pending: ["later@example.com"],
    });
  });

  it("makes a pending membership real when that email signs up", async () => {
    const a = await newUser("a");
    const slug = await sharedOrg(a);
    const added = await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: "Newbie@Example.com" } });
    expect([added.status, added.body.pending]).toEqual([201, ["newbie@example.com"]]);

    const signup = await signUp("newbie@example.com", `newbie-${randomUUID().slice(0, 8)}`);
    expect(signup.status).toBe(201);
    const orgs = (await call("GET", "/orgs", { key: signup.body.token })).body.data as { slug: string }[];
    expect(orgs.map((o) => o.slug)).toEqual(expect.arrayContaining([slug]));

    const list = (await call("GET", `/orgs/${slug}/members`, { key: a })).body;
    expect(list.pending).toEqual([]);
    expect(list.members).toHaveLength(2);
  });

  it("claims a pending membership for an existing user whose invite raced their signup", async () => {
    const a = await newUser("a");
    const slug = await sharedOrg(a);
    const b = await newUser("b");
    const bUser = await me(b);
    const [org] = await db.query<{ id: string }>(`SELECT id FROM loopway.orgs WHERE slug = $1`, [slug]);
    await db.query(`INSERT INTO loopway.org_invites (org_id, email, created_by) VALUES ($1, $2, 'test')`, [
      org!.id,
      bUser.email,
    ]);
    const { code } = await createLoginCode(db, bUser.email);
    expect((await call("POST", "/auth/verify", { body: { email: bUser.email, code } })).status).toBe(201);
    const orgs = (await call("GET", "/orgs", { key: b })).body.data as { slug: string }[];
    expect(orgs.map((o) => o.slug)).toContain(slug);
  });

  it("lets a pending membership lapse after 7 days, and a fresh add starts a new one", async () => {
    const a = await newUser("a");
    const slug = await sharedOrg(a);
    await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: "slow@example.com" } });
    const age = (days: number) =>
      db.query(`UPDATE loopway.org_invites SET created_at = now() - make_interval(days => $1) WHERE email = $2`, [
        days,
        "slow@example.com",
      ]);

    await age(6);
    expect((await call("GET", `/orgs/${slug}/members`, { key: a })).body.pending).toEqual(["slow@example.com"]);
    await age(8);
    expect((await call("GET", `/orgs/${slug}/members`, { key: a })).body.pending).toEqual([]);

    const again = await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: "slow@example.com" } });
    expect([again.status, again.body.pending]).toEqual([201, ["slow@example.com"]]);

    await age(8);
    const signup = await signUp("slow@example.com", `slow-${randomUUID().slice(0, 8)}`);
    const orgs = (await call("GET", "/orgs", { key: signup.body.token })).body.data as { slug: string }[];
    expect(orgs.map((o) => o.slug)).not.toContain(slug);
  });

  it("is harmless to add twice", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const slug = await sharedOrg(a);
    for (const email of [(await me(b)).email, "ghost@example.com"]) {
      const first = await call("POST", `/orgs/${slug}/members`, { key: a, body: { email } });
      const again = await call("POST", `/orgs/${slug}/members`, { key: a, body: { email } });
      expect([first.status, again.status]).toEqual([201, 200]);
      expect(again.body).toEqual(first.body);
    }
  });

  it("rejects an invalid email", async () => {
    const a = await newUser("a");
    const slug = await sharedOrg(a);
    expect((await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: "nope" } })).status).toBe(400);
  });

  it("answers 404 to non-members on list, add and remove, and changes nothing", async () => {
    const a = await newUser("a");
    const outsider = await newUser("out");
    const slug = await sharedOrg(a);
    const aId = (await me(a)).id;
    await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: "ghost@example.com" } });

    const attempts = [
      await call("GET", `/orgs/${slug}/members`, { key: outsider }),
      await call("POST", `/orgs/${slug}/members`, { key: outsider, body: { email: (await me(outsider)).email } }),
      await call("DELETE", `/orgs/${slug}/members/${aId}`, { key: outsider }),
      await call("DELETE", `/orgs/${slug}/members/pending?email=ghost@example.com`, { key: outsider }),
      await call("GET", `/orgs/no-such-org/members`, { key: outsider }),
    ];
    for (const r of attempts) expect(r.status).toBe(404);

    const list = (await call("GET", `/orgs/${slug}/members`, { key: a })).body;
    expect(list.members).toHaveLength(1);
    expect(list.pending).toEqual(["ghost@example.com"]);
  });

  it("lets a member remove another member or leave, but never the last one", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const c = await newUser("c");
    const slug = await sharedOrg(a, b, c);
    const [aId, bId, cId] = [(await me(a)).id, (await me(b)).id, (await me(c)).id];

    expect((await call("DELETE", `/orgs/${slug}/members/${bId}`, { key: a })).status).toBe(204);
    expect((await call("GET", `/orgs/${slug}/members`, { key: b })).status).toBe(404);
    expect((await call("DELETE", `/orgs/${slug}/members/${bId}`, { key: a })).status).toBe(404);
    expect((await call("DELETE", `/orgs/${slug}/members/not-a-uuid`, { key: a })).status).toBe(404);

    // leaving is removing yourself
    expect((await call("DELETE", `/orgs/${slug}/members/${cId}`, { key: c })).status).toBe(204);
    const last = await call("DELETE", `/orgs/${slug}/members/${aId}`, { key: a });
    expect([last.status, last.body.error.code]).toEqual([409, "last_member"]);
    expect((await call("GET", `/orgs/${slug}/members`, { key: a })).body.members).toHaveLength(1);
  });

  it("can't leave a personal org, whose only member is its owner", async () => {
    const a = await newUser("a");
    const { id, username } = await me(a);
    const r = await call("DELETE", `/orgs/${username}/members/${id}`, { key: a });
    expect([r.status, r.body.error.code]).toEqual([409, "last_member"]);
  });

  it("rejects adding anyone to a personal org, storing nothing", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const { id, username } = await me(a);
    for (const email of [(await me(b)).email, "ghost@example.com"]) {
      const r = await call("POST", `/orgs/${username}/members`, { key: a, body: { email } });
      expect([r.status, r.body.error.code]).toEqual([409, "personal_org"]);
    }
    const list = (await call("GET", `/orgs/${username}/members`, { key: a })).body;
    expect(list.members.map((m: { id: string }) => m.id)).toEqual([id]);
    expect(list.pending).toEqual([]);
  });

  it("refuses a second member or an invite on a personal org in the store and the database", async () => {
    const a = await newUser("a");
    const b = await newUser("b");
    const { username } = await me(a);
    const [org] = await db.query<{ id: string }>(`SELECT id FROM loopway.orgs WHERE slug = $1`, [username]);
    expect(await addOrgMember(db, org!.id, (await me(a)).id, (await me(b)).email)).toBe("personal_org");
    expect(await addOrgMember(db, org!.id, (await me(a)).id, "ghost@example.com")).toBe("personal_org");
    await expect(
      db.query(`INSERT INTO loopway.org_members (org_id, user_id, created_by) VALUES ($1, $2, 'test')`, [
        org!.id,
        (await me(b)).id,
      ]),
    ).rejects.toThrow(/personal orgs/);
    await expect(
      db.query(`INSERT INTO loopway.org_invites (org_id, email, created_by) VALUES ($1, 'ghost@example.com', 'test')`, [
        org!.id,
      ]),
    ).rejects.toThrow(/personal orgs/);
  });

  it("removes a pending email", async () => {
    const a = await newUser("a");
    const slug = await sharedOrg(a);
    await call("POST", `/orgs/${slug}/members`, { key: a, body: { email: "ghost@example.com" } });
    const gone = await call("DELETE", `/orgs/${slug}/members/pending?email=Ghost@Example.com`, { key: a });
    expect(gone.status).toBe(204);
    expect((await call("GET", `/orgs/${slug}/members`, { key: a })).body.pending).toEqual([]);
    const again = await call("DELETE", `/orgs/${slug}/members/pending?email=ghost@example.com`, { key: a });
    expect(again.status).toBe(404);
    expect((await call("DELETE", `/orgs/${slug}/members/pending`, { key: a })).status).toBe(400);
  });
});
