import { describe, expect, it, vi } from "vitest";
import { createApi } from "../src/api.js";
import { consoleSender, DEFAULT_EMAIL_FROM, senderFromEnv } from "../src/email.js";
import { db, SECRET } from "./helpers.js";

const email = { to: "a@example.com", subject: "hi", text: "body" };

describe("senderFromEnv", () => {
  it("sends from EMAIL_FROM through Resend", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await senderFromEnv({ RESEND_API_KEY: "re_key", EMAIL_FROM: "Acme <login@acme.test>" }, fetchFn)(email);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).from).toBe("Acme <login@acme.test>");
  });

  it("falls back to the default sender when EMAIL_FROM is unset", async () => {
    const fetchFn = vi.fn(async () => new Response("{}", { status: 200 }));
    await senderFromEnv({ RESEND_API_KEY: "re_key" }, fetchFn)(email);
    const [, init] = fetchFn.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string).from).toBe(DEFAULT_EMAIL_FROM);
  });

  it("prints to the console without RESEND_API_KEY", () => {
    expect(senderFromEnv({ EMAIL_FROM: "x <x@x.test>" })).toBe(consoleSender);
  });
});

describe("login email failure", () => {
  it("records login_email_failed when sending throws", async () => {
    const events: string[] = [];
    const a = createApi({
      getDb: async () => db,
      tokenSecret: SECRET,
      metrics: { capture: async (event) => void events.push(event) },
      sendEmail: async () => {
        throw new Error("Resend responded 500");
      },
    });
    const res = await a.request("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "fail@example.com" }),
    });
    expect(res.status).toBeGreaterThanOrEqual(500);
    expect(events).toContain("login_email_failed");
  });
});
