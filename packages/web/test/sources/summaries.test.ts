import { describe, expect, it } from "vitest";
import { sources } from "../../src/sources.js";

const event = (type: string, data: object, subject?: string) => ({
  specversion: "1.0" as const,
  id: "e-1",
  source: "https://example.com",
  type,
  subject,
  data,
});
const summary = (source: string, e: ReturnType<typeof event>) => sources.summarize(source, e);
const title = (source: string, e: ReturnType<typeof event>) => sources.title(source, e);

describe("linear summaries", () => {
  const issue = { identifier: "ENG-12", title: "Fix the login bug" };
  it("says who did what to which issue", () => {
    const e = event("com.linear.issue.create", { actor: { name: "Alice" }, data: issue });
    expect(summary("linear", e)).toBe("Alice created issue ENG-12: Fix the login bug");
    expect(title("linear", e)).toBe("Fix the login bug");
  });

  it("quotes a comment and takes the title from its issue", () => {
    const e = event("com.linear.comment.create", {
      actor: { name: "Bob" },
      data: { body: "On it\nsecond line", issue: { identifier: "ENG-12", title: "Fix the login bug" } },
    });
    expect(summary("linear", e)).toBe("Bob commented on ENG-12: On it");
    expect(title("linear", e)).toBe("Fix the login bug");
  });

  it("has no title for other resources", () => {
    const e = event("com.linear.project.update", { data: { name: "Q4" } });
    expect(summary("linear", e)).toBe("Someone updated project: Q4");
    expect(title("linear", e)).toBeNull();
  });
});

describe("vercel summaries", () => {
  it("names the event and the deployment", () => {
    const e = event("com.vercel.deployment.error", {
      payload: { deployment: { name: "loopway", meta: { githubCommitMessage: "Add titles\n\nbody" } } },
    });
    expect(summary("vercel", e)).toBe("deployment error for loopway: Add titles");
    expect(title("vercel", e)).toBeNull();
  });

  it("copes with a payload that has nothing to name", () => {
    expect(summary("vercel", event("com.vercel.domain.certificate-add", {}))).toBe("domain certificate add");
  });
});

describe("granola summaries", () => {
  it("says what happened to the note, with its title when there is one", () => {
    const e = event("ai.granola.note.generated", { note_id: "n1", title: "Weekly sync" });
    expect(summary("granola", e)).toBe("Granola note generated: Weekly sync");
    expect(title("granola", e)).toBe("Weekly sync");
    const bare = event("ai.granola.note.edited", { note_id: "n1" });
    expect(summary("granola", bare)).toBe("Granola note edited");
    expect(title("granola", bare)).toBeNull();
  });
});

describe("resend summaries", () => {
  it("names the email, contact or domain the event is about", () => {
    const mail = event("com.resend.email.bounced", { type: "email.bounced", data: { subject: "Welcome" } });
    expect(summary("resend", mail)).toBe("Resend email bounced: Welcome");
    expect(title("resend", mail)).toBe("Welcome");
    const contact = event("com.resend.contact.created", { type: "contact.created", data: { email: "a@b.co" } });
    expect(summary("resend", contact)).toBe("Resend contact created: a@b.co");
    const domain = event("com.resend.domain.updated", { type: "domain.updated", data: { name: "example.com" } });
    expect(title("resend", domain)).toBe("example.com");
    expect(title("resend", event("com.resend.domain.deleted", { type: "domain.deleted", data: {} }))).toBeNull();
  });
});

describe("loopway summaries", () => {
  it("uses the message type and id", () => {
    const e = event("build.finished", { title: "Build 42" }, "build.finished/42");
    expect(summary("loopway", e)).toBe("build.finished 42: Build 42");
    expect(title("loopway", e)).toBe("Build 42");
    expect(summary("loopway", event("build.finished", {}, "build.finished/42"))).toBe("build.finished 42");
  });
});

describe("registry", () => {
  it("returns null for a source that isn't registered", () => {
    expect(sources.summarize("nope", event("x", {}))).toBeNull();
    expect(sources.title("nope", event("x", {}))).toBeNull();
  });
});
