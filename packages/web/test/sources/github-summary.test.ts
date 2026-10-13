import { describe, expect, it } from "vitest";
import { sources } from "../../src/sources.js";

const github = sources.get("github")!;
const sender = { login: "mcwhittemore" };
const repository = { full_name: "craftmill/loopway", url: "https://api.github.com/repos/craftmill/loopway" };
const event = (type: string, data: object) => ({
  specversion: "1.0" as const,
  id: "d-1",
  source: repository.url,
  type,
  data: { sender, repository, ...data },
});
const summary = (type: string, data: object) => github.summarize(event(type, data));
const title = (type: string, data: object) => github.title(event(type, data));

describe("github summarize", () => {
  it("says who opened an issue or pull request", () => {
    const issue = { number: 12, title: "Redesign the dashboard", user: sender };
    expect(summary("com.github.issues.opened", { action: "opened", issue })).toBe(
      "mcwhittemore opened issue #12: Redesign the dashboard",
    );
    const pull_request = { number: 12, title: "Add titles", merged: false };
    expect(summary("com.github.pull_request.opened", { action: "opened", number: 12, pull_request })).toBe(
      "mcwhittemore opened pull request #12: Add titles",
    );
    expect(
      summary("com.github.pull_request.closed", {
        action: "closed",
        number: 12,
        pull_request: { ...pull_request, merged: true },
      }),
    ).toBe("mcwhittemore merged pull request #12: Add titles");
  });

  it("quotes the first line of a comment, truncated", () => {
    const issue = { number: 156, title: "Redesign" };
    expect(
      summary("com.github.issue_comment.created", {
        action: "created",
        issue,
        comment: { body: "Cut ticket 5\r\n\r\nand more below" },
      }),
    ).toBe("mcwhittemore commented on #156: Cut ticket 5");
    const long = summary("com.github.issue_comment.created", {
      action: "created",
      issue,
      comment: { body: "word ".repeat(40) },
    })!;
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThan(120);
    expect(summary("com.github.issue_comment.edited", { action: "edited", issue, comment: { body: "" } })).toBe(
      "mcwhittemore edited a comment on #156",
    );
  });

  it("covers reviews and inline review comments", () => {
    const pull_request = { number: 9, title: "T" };
    expect(
      summary("com.github.pull_request_review.submitted", {
        action: "submitted",
        pull_request,
        review: { state: "approved", body: "Ship it" },
      }),
    ).toBe("mcwhittemore approved #9: Ship it");
    expect(
      summary("com.github.pull_request_review.submitted", {
        action: "submitted",
        pull_request,
        review: { state: "changes_requested", body: null },
      }),
    ).toBe("mcwhittemore requested changes on #9");
    expect(
      summary("com.github.pull_request_review_comment.created", {
        action: "created",
        pull_request,
        comment: { body: "nit: rename" },
      }),
    ).toBe("mcwhittemore commented on #9: nit: rename");
  });

  it("counts the commits in a push", () => {
    expect(summary("com.github.push", { ref: "refs/heads/main", commits: [{}, {}, {}] })).toBe(
      "mcwhittemore pushed 3 commits to main",
    );
    expect(summary("com.github.push", { ref: "refs/heads/dev", commits: [{}] })).toBe(
      "mcwhittemore pushed 1 commit to dev",
    );
  });

  it("names the ref type for branch and tag creation and deletion", () => {
    expect(summary("com.github.create.branch", { ref: "main", ref_type: "branch" })).toBe(
      "mcwhittemore created branch main",
    );
    expect(summary("com.github.delete.tag", { ref: "v1", ref_type: "tag" })).toBe("mcwhittemore deleted tag v1");
  });

  it("falls back to the actor and type for events it doesn't know", () => {
    expect(summary("com.github.gollum", {})).toBe("mcwhittemore gollum");
    expect(summary("com.github.made_up.thing", {})).toBe("mcwhittemore made_up thing");
  });

  it("has nothing to say without an actor", () => {
    expect(github.summarize({ ...event("com.github.push", {}), data: {} })).toBeNull();
  });
});

describe("github title", () => {
  it("is the issue or pull request title the event carries", () => {
    expect(title("com.github.issues.opened", { issue: { title: "An issue" } })).toBe("An issue");
    expect(title("com.github.pull_request.opened", { pull_request: { title: "A PR" } })).toBe("A PR");
    expect(title("com.github.issue_comment.created", { issue: { title: "Commented on" }, comment: {} })).toBe(
      "Commented on",
    );
  });

  it("is null when the event has none", () => {
    expect(title("com.github.push", { ref: "refs/heads/main" })).toBeNull();
  });
});
