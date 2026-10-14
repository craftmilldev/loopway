import { describe, expect, it } from "vitest";
import { openTestDb } from "../src/db/testing.js";
import { migrations } from "../src/db/migrations.js";
import { RESERVED_SLUGS } from "../src/reserved-slugs.js";
import { slugProblem } from "../src/slugs.js";
import { call, db, newUser, newUserWithoutOrg } from "./helpers.js";

const rows = <T>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);

describe("slug rules", () => {
  it("accepts lowercase letters, digits and inner hyphens, 2-39 chars", () => {
    for (const ok of ["ab", "a-b", "a1", "9z", "x".repeat(39), "mc-whittemore"])
      expect(slugProblem(ok)).toBeUndefined();
  });

  it("rejects everything else", () => {
    expect(slugProblem("a")).toBe("too_short");
    expect(slugProblem("")).toBe("too_short");
    expect(slugProblem("x".repeat(40))).toBe("too_long");
    expect(slugProblem("Abc")).toBe("invalid_chars");
    expect(slugProblem("a_b")).toBe("invalid_chars");
    expect(slugProblem("a.b")).toBe("invalid_chars");
    expect(slugProblem("-ab")).toBe("edge_hyphen");
    expect(slugProblem("ab-")).toBe("edge_hyphen");
  });

  it("rejects the reserved words", () => {
    for (const word of RESERVED_SLUGS) expect(slugProblem(word)).toBe("reserved");
    for (const word of ["api", "dashboard", "auth", "health", "webhooks", "login", "signup", "me", "orgs", "new"]) {
      expect(RESERVED_SLUGS.has(word)).toBe(true);
    }
  });
});

describe("choosing a username", () => {
  it("makes a personal org and a membership for a user who has none", async () => {
    const key = await newUserWithoutOrg("Fresh");
    expect((await call("GET", "/me", { key })).body.username).toBeNull();
    expect((await call("GET", "/orgs", { key })).body.data).toEqual([]);

    const r = await call("PATCH", "/me/username", { key, body: { username: "Fresh-One" } });
    expect(r.status).toBe(200);
    expect(r.body.username).toBe("fresh-one");
    expect((await call("GET", "/me", { key })).body.username).toBe("fresh-one");

    const orgs = (await call("GET", "/orgs", { key })).body.data;
    expect(orgs).toEqual([{ id: expect.any(String), slug: "fresh-one", name: "fresh-one", personal: true }]);
    const members = await rows(`SELECT user_id FROM loopway.org_members WHERE org_id = $1`, [orgs[0].id]);
    expect(members).toHaveLength(1);
  });

  it("signup makes the personal org and membership in one go", async () => {
    const key = await newUser("Signup");
    const me = (await call("GET", "/me", { key })).body;
    const orgs = (await call("GET", "/orgs", { key })).body.data;
    expect(orgs).toEqual([{ id: expect.any(String), slug: me.username, name: me.username, personal: true }]);
    expect(await rows(`SELECT 1 FROM loopway.org_members WHERE org_id = $1`, [orgs[0].id])).toHaveLength(1);
  });

  it("rejects taken, reserved and malformed names with clear errors", async () => {
    const a = await newUserWithoutOrg();
    const b = await newUserWithoutOrg();
    expect((await call("PATCH", "/me/username", { key: a, body: { username: "taken-name" } })).status).toBe(200);

    const taken = await call("PATCH", "/me/username", { key: b, body: { username: "taken-name" } });
    expect([taken.status, taken.body.error.code]).toEqual([409, "username_taken"]);

    // an org that isn't anyone's personal org holds its slug too
    const [org] = await rows<{ id: string }>(
      `INSERT INTO loopway.orgs (id, slug, name) VALUES (gen_random_uuid(), 'some-org', 'Some org') RETURNING id`,
    );
    expect(org).toBeDefined();
    const orgTaken = await call("PATCH", "/me/username", { key: b, body: { username: "some-org" } });
    expect([orgTaken.status, orgTaken.body.error.code]).toEqual([409, "username_taken"]);

    const reserved = await call("PATCH", "/me/username", { key: b, body: { username: "dashboard" } });
    expect([reserved.status, reserved.body.error.code]).toEqual([400, "username_reserved"]);

    for (const bad of ["a", "has space", "-lead", "trail-", "x".repeat(40)]) {
      const r = await call("PATCH", "/me/username", { key: b, body: { username: bad } });
      expect([r.status, r.body.error.code]).toEqual([400, "invalid_username"]);
    }
    expect((await call("PATCH", "/me/username", { key: b, body: {} })).status).toBe(400);
    expect((await call("GET", "/me", { key: b })).body.username).toBeNull();
  });

  it("checks availability", async () => {
    const a = await newUser();
    await call("PATCH", "/me/username", { key: a, body: { username: "check-me" } });
    const b = await newUser();
    const check = async (name: string, key = b) => (await call("GET", `/usernames/${name}`, { key })).body;
    expect(await check("free-name")).toEqual({ username: "free-name", available: true });
    expect(await check("check-me")).toMatchObject({ available: false, reason: "taken" });
    expect(await check("login")).toMatchObject({ available: false, reason: "reserved" });
    expect(await check("a")).toMatchObject({ available: false, reason: "too_short" });
    // your own name is available to you
    expect(await check("check-me", a)).toMatchObject({ available: true });
    expect((await call("GET", "/usernames/free-name")).status).toBe(401);
  });

  it("renames the personal org's slug under the same rules", async () => {
    const a = await newUser();
    const b = await newUser();
    await call("PATCH", "/me/username", { key: a, body: { username: "old-name" } });
    await call("PATCH", "/me/username", { key: b, body: { username: "other-name" } });
    const orgId = (await call("GET", "/orgs", { key: a })).body.data[0].id;

    expect((await call("PATCH", "/me/username", { key: a, body: { username: "other-name" } })).status).toBe(409);
    expect((await call("PATCH", "/me/username", { key: a, body: { username: "api" } })).status).toBe(400);
    expect((await call("PATCH", "/me/username", { key: a, body: { username: "new-name" } })).status).toBe(200);

    const orgs = (await call("GET", "/orgs", { key: a })).body.data;
    expect(orgs).toHaveLength(1);
    expect(orgs[0]).toMatchObject({ id: orgId, slug: "new-name", name: "new-name", personal: true });
    expect((await call("GET", "/me", { key: a })).body.username).toBe("new-name");
    // the old slug is free again, with no redirect
    expect((await call("GET", "/usernames/old-name", { key: b })).body.available).toBe(true);
  });
});

describe("GET /orgs", () => {
  it("lists only the caller's orgs", async () => {
    const a = await newUser();
    const b = await newUser();
    await call("PATCH", "/me/username", { key: a, body: { username: "orgs-a" } });
    await call("PATCH", "/me/username", { key: b, body: { username: "orgs-b" } });
    const shared = "00000000-0000-4000-8000-0000000000aa";
    await rows(`INSERT INTO loopway.orgs (id, slug, name) VALUES ($1, 'team-a', 'Team A')`, [shared]);
    await rows(
      `INSERT INTO loopway.org_members (org_id, user_id)
       SELECT $1, m.user_id FROM loopway.org_members m JOIN loopway.orgs o ON o.id = m.org_id WHERE o.slug = 'orgs-a'`,
      [shared],
    );

    const mine = (await call("GET", "/orgs", { key: a })).body.data;
    expect(mine.map((o: { slug: string; personal: boolean }) => [o.slug, o.personal])).toEqual([
      ["orgs-a", true],
      ["team-a", false],
    ]);
    expect((await call("GET", "/orgs", { key: b })).body.data.map((o: { slug: string }) => o.slug)).toEqual(["orgs-b"]);
    expect((await call("GET", "/orgs")).status).toBe(401);
  });
});

describe("migration", () => {
  // Runs 017's statements again on a fresh database that has these users in it, as the real one did before migrating.
  async function migrateWith(emails: string[]) {
    const fresh = await openTestDb();
    try {
      await fresh.query(`DROP TABLE loopway.org_members CASCADE`);
      await fresh.query(`DROP TABLE loopway.orgs CASCADE`);
      for (const email of emails) {
        await fresh.query(`INSERT INTO loopway.users (id, name, email) VALUES (gen_random_uuid(), 'u', $1)`, [email]);
      }
      const m = migrations.find((x) => x.version === "017_orgs")!;
      for (const stmt of m.sql
        .split(/;\s*$/m)
        .map((x) => x.trim())
        .filter(Boolean))
        await fresh.query(stmt);
      return await fresh.query<{ email: string; slug: string; personal: boolean }>(
        `SELECT u.email, o.slug, (o.personal_user_id IS NOT NULL) AS personal
         FROM loopway.org_members m JOIN loopway.users u ON u.id = m.user_id JOIN loopway.orgs o ON o.id = m.org_id
         ORDER BY o.slug`,
      );
    } finally {
      await fresh.close();
    }
  }

  it("gives matthew@craftmill.dev the personal org mcwhittemore and membership in craftmill", async () => {
    const members = await migrateWith(["Matthew@craftmill.dev"]);
    expect(members.map((r) => [r.slug, r.personal])).toEqual([
      ["craftmill", false],
      ["mcwhittemore", true],
    ]);
  });

  it("is a no-op where that user doesn't exist", async () => {
    expect(await migrateWith([])).toEqual([]);
    expect(await migrateWith(["someone@example.com"])).toEqual([]);
  });
});
