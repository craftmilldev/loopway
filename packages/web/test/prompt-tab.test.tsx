// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Bot, tabPath } from "../client/bot.js";
import { fromDrafts, problem, rulesText, sameRules, toDrafts } from "../client/prompt.js";

const rule = { types: ["com.github.*"], subject: "data.id", action: "'attach'" };
const v2 = { version: 2, prompt: "line one\nline two", rules: [rule], created_at: "2026-10-02T00:00:00Z" };
const v1 = { version: 1, prompt: "line one\nold two", rules: [{ types: ["x.*"] }], created_at: "2026-10-01T00:00:00Z" };
const bot = {
  id: "b1",
  name: "dev",
  model: "sonnet",
  prompt_version: v2,
  inbox_ids: ["i1"],
  cursor: 1,
  runner_id: null,
  leased_until: null,
};

let posts: { prompt: string; rules: unknown }[];
let postStatus: number;

beforeEach(() => {
  localStorage.setItem("loopway_token", "t");
  posts = [];
  postStatus = 201;
  window.history.replaceState(null, "", "/dashboard/bots/b1/prompt");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string, init?: RequestInit) => {
      const path = apiPath.replace(/^\/api/, "");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (path === "/bots") return json({ data: [bot] });
      if (path === "/bots/b1") return json(bot);
      if (path === "/bots/b1/versions" && init?.method === "POST") {
        posts.push(JSON.parse(init.body as string));
        if (postStatus !== 201)
          return json({ error: { code: "invalid_rules", message: "Rule 1: bad expression" } }, postStatus);
        return json({ ...v2, version: 3 }, 201);
      }
      if (path === "/bots/b1/versions") return json({ data: [v2, v1] });
      if (path === "/runners" || path === "/inboxes" || path.endsWith("/threads?status=active"))
        return json({ data: [] });
      return json({}, 404);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

// The textarea can show before the bot and versions finish loading, and late data resets the draft.
const editor = async () => {
  await screen.findByRole("link", { name: "Prompt and rules · v2" });
  return await screen.findByLabelText<HTMLTextAreaElement>("Prompt");
};
const type = (el: HTMLElement, value: string) => fireEvent.change(el, { target: { value } });

describe("helpers", () => {
  it("round-trips rules through drafts", () => {
    const rules = [rule, { types: ["a", "b"] }];
    expect(fromDrafts(toDrafts(rules))).toEqual(rules);
    expect(toDrafts(null)).toEqual([]);
  });

  it("names the first problem the way the API would", () => {
    expect(problem("", [rule])?.reason).toBe("no_prompt");
    expect(problem("p", [])?.reason).toBe("no_rules");
    expect(problem("p", [rule, { types: [] }])?.message).toBe("Rule 2 needs at least one event type.");
    expect(problem("p", [rule])).toBeNull();
  });

  it("writes rules as lines", () => {
    expect(rulesText([rule])).toBe("Rule 1\n  types: com.github.*\n  subject: data.id\n  action: 'attach'");
  });

  it("compares rules structurally", () => {
    // jsonb hands keys back as types, action, related, subject
    const full = { types: ["a.*", "b.*"], action: "'skip'", related: "[]", subject: "data.id" };
    const built = { types: ["a.*", "b.*"], subject: "data.id", related: "[]", action: "'skip'" };
    expect(sameRules([full], [built])).toBe(true);
    expect(sameRules([{ types: ["a"], subject: "  s " }], [{ types: ["a"], subject: "s" }])).toBe(true);
    expect(sameRules([{ types: ["a"], subject: "" }], [{ types: ["a"] }])).toBe(true);
    expect(sameRules(null, [])).toBe(true);
    expect(sameRules([{ types: ["a"] }], [])).toBe(false);
    expect(sameRules([{ types: ["a"], action: "x" }], [{ types: ["a"], action: "y" }])).toBe(false);
    expect(sameRules([{ types: ["a", "b"] }], [{ types: ["b", "a"] }])).toBe(false);
    expect(sameRules([{ types: ["a"] }, { types: ["b"] }], [{ types: ["b"] }, { types: ["a"] }])).toBe(false);
  });

  it("puts the prompt tab on its own path", () => {
    expect(tabPath("b 1", "prompt")).toBe("/dashboard/bots/b%201/prompt");
  });
});

describe("Prompt and rules tab", () => {
  it("shows the current prompt, count and rules, with no draft bar", async () => {
    render(<Bot id="b1" view="prompt" />);
    expect((await editor()).value).toBe("line one\nline two");
    expect(screen.getByText("17 characters")).toBeTruthy();
    expect(screen.getByText("com.github.*")).toBeTruthy();
    expect(screen.getByText("data.id")).toBeTruthy();
    expect(screen.queryByText(/Draft of version/)).toBeNull();
    expect(screen.getByRole("link", { name: "Prompt and rules · v2" }).getAttribute("aria-current")).toBe("page");
  });

  it("no longer edits the prompt on the Settings tab", async () => {
    window.history.replaceState(null, "", "/dashboard/bots/b1?tab=settings");
    render(<Bot id="b1" />);
    await screen.findByLabelText("Name");
    expect(screen.queryByLabelText("Prompt")).toBeNull();
  });

  it("makes a draft on edit and discards it", async () => {
    render(<Bot id="b1" view="prompt" />);
    type(await editor(), "changed");
    expect(screen.getByText("Draft of version 3")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(screen.queryByText(/Draft of version/)).toBeNull();
    expect((await editor()).value).toBe("line one\nline two");
  });

  it("saves the draft as the next version", async () => {
    render(<Bot id="b1" view="prompt" />);
    type(await editor(), "changed");
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    await waitFor(() => expect(posts).toEqual([{ prompt: "changed", rules: [rule] }]));
  });

  it("shows the API's error and keeps the draft", async () => {
    postStatus = 400;
    render(<Bot id="b1" view="prompt" />);
    type(await editor(), "changed");
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Rule 1: bad expression");
    expect(screen.getByText("Draft of version 3")).toBeTruthy();
  });

  it("refuses to save a rule without event types, without calling the API", async () => {
    render(<Bot id="b1" view="prompt" />);
    await editor();
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Rule 2 needs at least one event type.");
    expect(posts).toEqual([]);
  });

  it("edits, adds and reorders rules", async () => {
    render(<Bot id="b1" view="prompt" />);
    await editor();
    fireEvent.click(screen.getByRole("button", { name: /Edit.*rule 1/ }));
    type(screen.getByLabelText("Subject"), "data.other");
    fireEvent.click(screen.getByRole("button", { name: "Add rule" }));
    type(screen.getByLabelText("Rule 2 · event types"), "second.*");
    fireEvent.click(screen.getByRole("button", { name: "Move rule 2 up" }));
    fireEvent.click(screen.getByRole("button", { name: "Save as version 3" }));
    await waitFor(() => expect(posts).toHaveLength(1));
    expect(posts[0]!.rules).toEqual([{ types: ["second.*"] }, { ...rule, subject: "data.other" }]);
  });

  it("removes a rule", async () => {
    render(<Bot id="b1" view="prompt" />);
    await editor();
    fireEvent.click(screen.getByRole("button", { name: /Remove.*rule 1/ }));
    expect(screen.getByText("No rules.")).toBeTruthy();
    expect(screen.getByText("Draft of version 3")).toBeTruthy();
  });

  it("compares an old version against the current one", async () => {
    render(<Bot id="b1" view="prompt" />);
    fireEvent.click(await screen.findByRole("button", { name: "Compare version 1" }));
    const prompt = screen.getByRole("group", { name: "Prompt changes" });
    expect(prompt.textContent).toContain("- old two");
    expect(prompt.textContent).toContain("+ line two");
    expect(screen.getByRole("group", { name: "Rule changes" }).textContent).toContain("+   types: com.github.*");
    expect(screen.queryByText(/Draft of version/)).toBeNull();
  });

  it("restores a version into the draft without saving", async () => {
    render(<Bot id="b1" view="prompt" />);
    fireEvent.click(await screen.findByRole("button", { name: "Restore version 1" }));
    expect((await editor()).value).toBe("line one\nold two");
    expect(screen.getByText("x.*")).toBeTruthy();
    expect(screen.getByText("Draft of version 3")).toBeTruthy();
    expect(posts).toEqual([]);
  });

  it("warns on leaving with an unsaved draft only", async () => {
    render(<Bot id="b1" view="prompt" />);
    const first = await editor();
    const clean = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);
    type(first, "changed");
    const dirty = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
  });

  describe("untouched", () => {
    const original = bot.prompt_version;
    afterEach(() => {
      bot.prompt_version = original;
    });
    const untouched = async (version: unknown) => {
      bot.prompt_version = version as typeof v2;
      render(<Bot id="b1" view="prompt" />);
      await editor();
      expect(screen.queryByText(/Draft of version/)).toBeNull();
      const e = new Event("beforeunload", { cancelable: true });
      window.dispatchEvent(e);
      expect(e.defaultPrevented).toBe(false);
    };

    it("shows no draft for rules with every field, in the order Postgres returns them", async () => {
      const rules = [{ types: ["a.*", "b.*"], action: "'skip'", related: "[]", subject: "data.id" }, { types: ["c"] }];
      await untouched({ ...v2, rules });
    });

    it("shows no draft for null rules", async () => {
      await untouched({ ...v2, rules: null });
    });

    it("shows no draft for a blank prompt", async () => {
      await untouched({ ...v2, prompt: "", rules: [] });
    });

    it("shows no draft for a prompt with a trailing newline", async () => {
      await untouched({ ...v2, prompt: "line one\r\nline two\n" });
    });
  });

  it("clears the draft when an edit is reverted", async () => {
    render(<Bot id="b1" view="prompt" />);
    const el = await editor();
    type(el, "changed");
    expect(await screen.findByText(/Draft of version/)).toBeTruthy();
    type(el, v2.prompt);
    await waitFor(() => expect(screen.queryByText(/Draft of version/)).toBeNull());
  });
});
