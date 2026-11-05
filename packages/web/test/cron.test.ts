import { describe, expect, it } from "vitest";
import { createApi } from "../src/api.js";
import { TEST_INBOX_KEY } from "../src/db/testing.js";
import { call, db, newSource, newUser, prPayload, SECRET, sendGithub } from "./helpers.js";

const tick = () =>
  createApi({ getDb: async () => db, tokenSecret: SECRET, inboxSecretKey: TEST_INBOX_KEY, cronSecret: "cron" }).request(
    "/api/cron/tick",
    { headers: { authorization: "Bearer cron" } },
  );

describe("the cron tick", () => {
  it("purges what's past retention and nothing else", async () => {
    const key = await newUser();
    const a = await newSource(key);
    await sendGithub(a, "pull_request", prPayload(1));
    await sendGithub(a, "pull_request", prPayload(2));
    await db.query(
      `UPDATE loopway.messages SET received_at = now() - interval '15 days'
       WHERE id = (SELECT id FROM loopway.messages WHERE user_id = $1 ORDER BY id LIMIT 1)`,
      [a.userId],
    );
    const res = await tick();
    expect(res.status).toBe(200);
    expect(((await res.json()) as { purged: number }).purged).toBeGreaterThanOrEqual(1);
    const rows = await db.query(`SELECT 1 FROM loopway.messages WHERE user_id = $1`, [a.userId]);
    expect(rows).toHaveLength(1);
    expect((await call("GET", "/inbox", { key })).body.messages).toBe(1);
  });
});
