import { describe, expect, it } from "vitest";
import { nextStep } from "../src/commands/inboxes.js";
import type { Inbox } from "../src/client.js";

const inbox = (source_type: string, config: Record<string, unknown>): Inbox => ({
  id: "i1",
  created_by: "user:u1",
  name: "Match to ticket",
  source_type,
  config,
  webhook_url: "https://loopway.test/api/webhooks/i1",
  created_at: "2026-10-22T00:00:00Z",
});

describe("nextStep", () => {
  it("gives a GitHub inbox the gh command with its URL and secret", () => {
    const text = nextStep(inbox("github", { secret: "s3cret-s3cret-s3cret", events: ["*"] }));
    expect(text).toContain("Settings → Webhooks");
    expect(text).toContain("gh api repos/OWNER/REPO/hooks");
    expect(text).toContain("'config[url]=https://loopway.test/api/webhooks/i1'");
    expect(text).toContain("'config[secret]=s3cret-s3cret-s3cret'");
    expect(text).toContain("'events[]=*'");
  });

  it("has nothing to add for other sources", () => {
    expect(nextStep(inbox("schedule", {}))).toBe("");
  });
});
