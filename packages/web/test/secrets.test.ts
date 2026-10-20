import { describe, expect, it } from "vitest";
import { secretBox } from "../src/secrets.js";
import { TEST_INBOX_KEY, openTestDb } from "../src/db/testing.js";
import { createInbox, encryptInboxSecrets } from "../src/store.js";
import { createUser, setUsername } from "../src/store.js";

const box = secretBox(TEST_INBOX_KEY);

describe("secretBox", () => {
  it("round-trips and does not repeat itself", () => {
    const a = box.seal("hunter2hunter2hunter2", "inbox-1");
    expect(a).not.toContain("hunter2");
    expect(box.open(a, "inbox-1")).toBe("hunter2hunter2hunter2");
    expect(box.seal("hunter2hunter2hunter2", "inbox-1")).not.toBe(a);
  });
  it("refuses another context, another key or a changed value", () => {
    const a = box.seal("s", "inbox-1");
    expect(() => box.open(a, "inbox-2")).toThrow();
    expect(() => secretBox(Buffer.alloc(32, "other").toString("base64")).open(a, "inbox-1")).toThrow();
    expect(() => box.open(a.slice(0, -2) + "AA", "inbox-1")).toThrow();
  });
  it("needs a 32-byte key", () => {
    expect(() => secretBox(undefined)).toThrow(/32 bytes/);
    expect(() => secretBox("c2hvcnQ=")).toThrow(/32 bytes/);
  });
});

describe("encryptInboxSecrets", () => {
  it("moves plaintext secrets out of config, once", async () => {
    const db = await openTestDb();
    try {
      const { user } = await createUser(db, { name: "M", email: "m@example.com" });
      await setUsername(db, user.id, "mattw");
      const [org] = await db.query<{ id: string }>(`SELECT id FROM loopway.orgs WHERE personal_user_id = $1`, [
        user.id,
      ]);
      const make = (config: object) =>
        createInbox(db, { userId: user.id, orgId: org!.id, name: "i", sourceType: "github", config });
      const withSecret = await make({ secret: "s".repeat(20), events: ["*"] });
      const unset = await make({ secret: null, events: ["*"] });
      const none = await make({ events: ["*"] });

      expect(await encryptInboxSecrets(db, box)).toBe(2);
      expect(await encryptInboxSecrets(db, box)).toBeNull();

      const rows = await db.query<{ id: string; config: object; secret_enc: string | null }>(
        `SELECT id, config, secret_enc FROM loopway.inboxes`,
      );
      const by = (id: string) => rows.find((r) => r.id === id)!;
      expect(by(withSecret.id).config).toEqual({ events: ["*"] });
      expect(box.open(by(withSecret.id).secret_enc!, withSecret.id)).toBe("s".repeat(20));
      expect(by(unset.id).secret_enc).toBeNull();
      expect(by(unset.id).config).toEqual({ events: ["*"] });
      expect(by(none.id).secret_enc).toBeNull();

      // Done once: a `secret` that shows up in a config afterwards is left alone, not sealed over the real one.
      const later = await make({ secret: "x".repeat(20), events: ["*"] });
      expect(await encryptInboxSecrets(db, box)).toBeNull();
      const [after] = await db.query<{ config: object }>(`SELECT config FROM loopway.inboxes WHERE id = $1`, [
        later.id,
      ]);
      expect(after!.config).toHaveProperty("secret");
    } finally {
      await db.close();
    }
  });
});
