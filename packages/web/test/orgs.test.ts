import { describe, expect, it } from "vitest";
import { openTestDb } from "../src/db/testing.js";
import { backfillOrgs } from "../src/db/backfill-orgs.js";
import { RESERVED_SLUGS, sanitizeSlug, slugProblem } from "../src/slugs.js";
import { createUser } from "../src/store.js";
import { signSessionToken } from "../src/tokens.js";
import { call, db, newUser, SECRET } from "./helpers.js";

const rows = <T>(sql: string, params: unknown[] = []) => db.query<T>(sql, params);

async function userWithEmail(email: string, name = email.split("@")[0]!) {
  const { user } = await createUser(db, { name, email });
  return { id: user.id, key: signSessionToken(user.id, SECRET).token };
}

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

  it("sanitizes an email local part", () => {
    expect(sanitizeSlug("First.Last+tag")).toBe("first-last-tag");
    expect(sanitizeSlug("__x__")).toBe("x");
    expect(sanitizeSlug("a".repeat(60))).toHaveLength(34);
  });
});

describe("choosing a username", () => {
  it("makes a personal org and a membership for a new signup", async () => {
    const key = await newUser("Fresh");
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

  it("rejects taken, reserved and malformed names with clear errors", async () => {
    const a = await newUser();
    const b = await newUser();
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

describe("migration backfill", () => {
  it("gives every existing user exactly one personal org and a membership", async () => {
    const plain = await userWithEmail("plain@example.com");
    const dotted = await userWithEmail("First.Last+x@example.com");
    const dup1 = await userWithEmail("dup@one.example");
    const dup2 = await userWithEmail("dup@two.example");
    const reserved = await userWithEmail("settings@example.com");
    const short = await userWithEmail("a@example.com");
    const noEmail = await createUser(db, { name: "No Email!" });

    await backfillOrgs(db);
    await backfillOrgs(db); // running again changes nothing

    const slugOf = async (id: string) =>
      (await rows<{ slug: string }>(`SELECT slug FROM loopway.orgs WHERE personal_user_id = $1`, [id])).map(
        (r) => r.slug,
      );
    expect(await slugOf(plain.id)).toEqual(["plain"]);
    expect(await slugOf(dotted.id)).toEqual(["first-last-x"]);
    expect(await slugOf(dup1.id)).toEqual(["dup"]);
    expect(await slugOf(dup2.id)).toEqual(["dup2"]);
    expect(await slugOf(reserved.id)).toEqual(["settings2"]);
    expect(await slugOf(short.id)).toEqual(["a2"]);
    expect(await slugOf(noEmail.user.id)).toEqual(["no-email"]);

    const lonely = await rows(
      `SELECT u.id FROM loopway.users u
       WHERE (SELECT count(*) FROM loopway.orgs o WHERE o.personal_user_id = u.id) <> 1
          OR NOT EXISTS (SELECT 1 FROM loopway.org_members m JOIN loopway.orgs o ON o.id = m.org_id
                         WHERE m.user_id = u.id AND o.personal_user_id = u.id)`,
    );
    // users made by earlier tests in this file's database have been backfilled too
    expect(lonely).toEqual([]);
    expect((await call("GET", "/me", { key: plain.key })).body.username).toBe("plain");
  });

  it("gives matthew@craftmill.dev mcwhittemore and a craftmill org", async () => {
    // someone else already using the local part must not take the founder's name
    await userWithEmail("mcwhittemore@example.com");
    const founder = await userWithEmail("Matthew@craftmill.dev");
    await backfillOrgs(db);

    const [personal] = await rows<{ slug: string }>(`SELECT slug FROM loopway.orgs WHERE personal_user_id = $1`, [
      founder.id,
    ]);
    expect(personal!.slug).toBe("mcwhittemore");
    const orgs = (await call("GET", "/orgs", { key: founder.key })).body.data;
    expect(orgs.map((o: { slug: string; personal: boolean }) => [o.slug, o.personal])).toEqual([
      ["mcwhittemore", true],
      ["craftmill", false],
    ]);
  });

  it("is a no-op on a fresh database", async () => {
    const fresh = await openTestDb();
    try {
      expect(await fresh.query(`SELECT 1 FROM loopway.orgs`)).toEqual([]);
    } finally {
      await fresh.close();
    }
  });
});
