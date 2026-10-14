// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PRESETS } from "@loopway/presets";
import { NewBot } from "../client/new-bot.js";

const orgs = [
  { id: "o1", slug: "me", name: "me", personal: true },
  { id: "o2", slug: "craftmill", name: "craftmill", personal: false },
];
const inbox = { id: "i1", org_id: "o1", name: "github", source_type: "github", webhook_url: "https://lw.test/in/i1" };
let bot: { id: string; name: string; model: string; inbox_ids: string[]; leased_until: string | null };
let threads: object[];
let posts: { path: string; body: any }[];

function stubFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string, init?: RequestInit) => {
      const path = apiPath.replace(/^\/api/, "");
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (init?.method === "POST") {
        posts.push({ path, body: JSON.parse(init.body as string) });
        return json(bot, 201);
      }
      if (path === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (path === "/orgs") return json({ data: orgs });
      if (path === "/inboxes") return json({ data: [inbox] });
      if (path === "/bots/b1") return json(bot);
      if (path === "/bots/b1/threads") return json({ data: threads });
      return json({}, 404);
    }),
  );
}

function at(search: string) {
  window.history.replaceState(null, "", "/acme/bots/new" + search);
}

beforeEach(() => {
  localStorage.setItem("loopway_token", "t");
  bot = { id: "b1", name: "dev", model: "sonnet", inbox_ids: ["i1"], leased_until: null };
  threads = [];
  posts = [];
  stubFetch();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("New bot flow", () => {
  it("walks the five steps and creates one bot with the chosen preset", async () => {
    at("");
    render(<NewBot />);
    fireEvent.click(await screen.findByLabelText(/github/));
    expect(screen.getByText("https://lw.test/in/i1")).toBeTruthy();
    fireEvent.click(screen.getByText("Continue"));

    expect(await screen.findByText("GitHub threads")).toBeTruthy();
    expect(screen.getAllByRole("radio")).toHaveLength(Object.keys(PRESETS).length);
    fireEvent.click(screen.getByText("Continue"));

    fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "dev" } });
    expect(screen.getAllByRole("radio").map((r) => (r.parentElement as HTMLElement).textContent?.trim())).toEqual([
      "sonnet",
      "opus",
      "fable",
      "haiku",
    ]);
    fireEvent.click(screen.getByText("Create bot and continue"));

    expect(await screen.findByText("Listening for a runner to take the lease…")).toBeTruthy();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.body).toEqual({
      org: "me",
      name: "dev",
      model: "sonnet",
      harness: "claude",
      prompt: PRESETS["github-threads"]!.prompt,
      rules: PRESETS["github-threads"]!.rules,
      inbox_ids: ["i1"],
    });
    expect(location.search).toBe("?bot=b1");
    expect(screen.queryByText("Loading…")).toBeNull();
    expect(localStorage.getItem("loopway_last_org")).toBe("me");

    // Back from the runner step shows the created bot and doesn't make another.
    fireEvent.click(screen.getByText("Back"));
    fireEvent.click(await screen.findByText("Continue"));
    expect(await screen.findByText("Listening for a runner to take the lease…")).toBeTruthy();
    expect(posts).toHaveLength(1);

    fireEvent.click(screen.getByText("Skip for now"));
    expect(await screen.findByText("Waiting for the first thread…")).toBeTruthy();
  });

  it("starts on the org something was last created in, and lists only its inboxes", async () => {
    localStorage.setItem("loopway_last_org", "craftmill");
    at("");
    render(<NewBot />);
    expect((await screen.findByLabelText<HTMLSelectElement>("Org")).value).toBe("craftmill");
    expect(screen.queryByLabelText(/github/)).toBeNull();

    fireEvent.change(screen.getByLabelText("Org"), { target: { value: "me" } });
    expect(await screen.findByLabelText(/github/)).toBeTruthy();
  });

  it("asks for an inbox before continuing", async () => {
    at("");
    render(<NewBot />);
    fireEvent.click(await screen.findByText("Continue"));
    expect(await screen.findByText("Pick or create at least one inbox.")).toBeTruthy();
  });

  it("resumes at the runner step for a bot nobody runs", async () => {
    at("?bot=b1");
    render(<NewBot />);
    expect(await screen.findByText("Listening for a runner to take the lease…")).toBeTruthy();
    expect(posts).toHaveLength(0);
  });

  it("notices the lease and resumes at the last step for a running bot", async () => {
    at("?bot=b1");
    render(<NewBot />);
    expect(await screen.findByText("Listening for a runner to take the lease…")).toBeTruthy();
    bot.leased_until = "2026-10-13T00:00:00Z";
    expect(
      await screen.findByText("A runner took the lease. Your bot is running.", {}, { timeout: 5000 }),
    ).toBeTruthy();
    cleanup();

    render(<NewBot />);
    expect(await screen.findByText("Waiting for the first thread…")).toBeTruthy();
  });

  it("links to the first thread once there is one", async () => {
    bot.leased_until = "2026-10-13T00:00:00Z";
    threads = [{ id: "t1" }];
    at("?bot=b1");
    render(<NewBot />);
    const link = await screen.findByText("Open the first thread");
    await waitFor(() => expect(link.getAttribute("href")).toBe("/acme/bots/b1/threads/t1"));
  });

  it("starts over when the bot is gone", async () => {
    at("?bot=nope");
    render(<NewBot />);
    expect(await screen.findByText("Where do its messages come from?")).toBeTruthy();
  });
});
