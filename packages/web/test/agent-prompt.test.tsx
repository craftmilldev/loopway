// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentPrompt, agentPrompt } from "../client/agent-prompt.js";
import { Bots } from "../client/bots.js";
import { track } from "../client/metrics.js";

vi.mock("../client/metrics.js", () => ({ track: vi.fn(), identify: vi.fn(), reset: vi.fn() }));

let bots: object[];

beforeEach(() => {
  localStorage.setItem("loopway_token", "t");
  bots = [];
  window.history.replaceState(null, "", "/acme/bots");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string) => {
      const path = apiPath.replace(/^\/api/, "");
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });
      if (path === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (path.startsWith("/bots/activity")) return json({ data: [] });
      if (path.startsWith("/bots?")) return json({ data: bots });
      if (path.startsWith("/runners") || path.startsWith("/inboxes") || path === "/orgs") return json({ data: [] });
      return json({ data: [] });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("agentPrompt", () => {
  it("names the org and the CLI steps", () => {
    const text = agentPrompt("acme", "https://lw.test");
    expect(text).toContain('org "acme"');
    expect(text).toContain("https://lw.test/llms.txt");
    expect(text).toContain("loopway login");
    expect(text).toContain("--org acme");
    expect(text).toContain("loopway bots run");
  });

  it("skips install, login and the runner once a runner is online", () => {
    const text = agentPrompt("acme", "https://lw.test", { runner: true, bot: false, ran: false });
    expect(text).toContain('org "acme"');
    expect(text).toContain("https://lw.test/llms.txt");
    expect(text).toContain("--org acme");
    expect(text).toContain("runner online");
    expect(text).not.toMatch(/install/i);
    expect(text).not.toContain("one-time code");
    expect(text).not.toContain("loopway bots run");
  });

  it("keeps the secret out of the agent's reply in both variants", () => {
    for (const progress of [undefined, { runner: true, bot: false, ran: false }]) {
      const text = agentPrompt("acme", "https://lw.test", progress);
      expect(text).not.toContain("webhook URL and secret");
      expect(text).toContain("loopway inbox update <inbox> --secret");
    }
  });

  it("keeps the full prompt while no runner is online", () => {
    const progress = { runner: false, bot: false, ran: false };
    expect(agentPrompt("acme", "https://lw.test", progress)).toBe(agentPrompt("acme", "https://lw.test"));
  });
});

describe("AgentPrompt", () => {
  it("copies the prompt with the org slug", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    render(<AgentPrompt from="bots" />);
    fireEvent.click(screen.getByText("Copy prompt"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(expect.stringContaining('org "acme"')));
    expect(track).toHaveBeenCalledWith("agent_prompt_copied", { from: "bots" });
  });

  it("records a copy the browser refused", async () => {
    vi.stubGlobal("navigator", {
      clipboard: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    render(<AgentPrompt from="bots" />);
    fireEvent.click(screen.getByText("Copy prompt"));
    await waitFor(() => expect(track).toHaveBeenCalledWith("agent_prompt_copy_failed", { from: "bots" }));
    expect(screen.queryByText("Copied")).toBeNull();
  });
});

describe("AgentPrompt by step", () => {
  it("shows and copies the step 2 variant", async () => {
    const writeText = vi.fn(async () => {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const { container } = render(<AgentPrompt from="zero" progress={{ runner: true, bot: false, ran: false }} />);
    const shown = container.querySelector("pre")?.textContent ?? "";
    expect(shown).not.toContain("loopway bots run");
    fireEvent.click(screen.getByText("Copy prompt"));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(shown));
  });
});

describe("Bots page", () => {
  it("leads with the agent prompt and keeps the forms behind a quiet link", async () => {
    render(<Bots />);
    expect(await screen.findByLabelText("Create your bot with your agent")).toBeTruthy();
    const link = screen.getByText("Create by hand");
    expect(link.getAttribute("href")).toBe("/acme/bots/new");
    expect(link.className).toContain("btn-quiet");
    fireEvent.click(link);
    expect(track).toHaveBeenCalledWith("bots_create_by_hand_clicked");
  });
});
