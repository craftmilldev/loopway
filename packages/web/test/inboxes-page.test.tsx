// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Inbox } from "../client/inbox.js";
import { eventsText, Inboxes } from "../client/inboxes.js";

const inbox = (over: object = {}) => ({
  id: "i1",
  name: "loopway-github",
  source_type: "github",
  webhook_url: "https://loopway.test/api/webhooks/i1",
  config: { secret: "s3cret", events: ["issues", "push"] },
  ...over,
});
const vercel = inbox({
  id: "i2",
  name: "vercel-prod",
  source_type: "vercel",
  webhook_url: "https://loopway.test/api/webhooks/i2",
  config: { secret: null, events: ["*"] },
});
const days = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    date: `2026-10-${String(i + 1).padStart(2, "0")}`,
    received: i === 0 ? 3 : 0,
  }));
const activity = (id: string, messages: number, last: string | null) => ({
  inbox_id: id,
  days: days(14),
  received: 3,
  messages,
  last_message_at: last,
});
const sources = {
  can_request: false,
  data: [
    {
      type: "github",
      label: "GitHub",
      description: "",
      events: ["issues", "push", "release"],
      secret: { from: "loopway", min_length: 16 },
      webhook_settings: "Settings › Webhooks",
    },
    {
      type: "vercel",
      label: "Vercel",
      description: "",
      events: ["deployment.created", "deployment.error"],
      secret: { from: "sender" },
      webhook_settings: "Vercel under Settings › Webhooks",
    },
  ],
};
const bots = [
  { id: "b1", name: "dev", inbox_ids: ["i1"], cursor: 0 },
  { id: "b2", name: "reviewer", inbox_ids: ["i1", "i2"], cursor: 0 },
];

let inboxes: object[];
let requests: { path: string; method: string; body: unknown }[];
let patchReply: { status: number; body: unknown };

beforeEach(() => {
  localStorage.setItem("loopway_token", "t");
  inboxes = [inbox(), vercel];
  requests = [];
  patchReply = { status: 200, body: {} };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string, init?: { method?: string; body?: string }) => {
      const path = apiPath.replace(/^\/api/, "");
      const method = init?.method ?? "GET";
      requests.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      const [p = ""] = path.split("?");
      if (p === "/me") return json({ id: "u1", email: null, name: "Me" });
      if (p === "/sources") return json(sources);
      if (p === "/bots") return json({ data: bots });
      if (p === "/inboxes") return json({ data: inboxes });
      if (p === "/inboxes/activity")
        return json({ data: [activity("i1", 2418, "2026-01-01T10:00:00Z"), activity("i2", 0, null)] });
      const one = p.match(/^\/inboxes\/(i\d)(\/messages)?$/);
      if (one && method === "PATCH") return json(patchReply.body, patchReply.status);
      if (one && method === "DELETE") return new Response(null, { status: 204 });
      if (one?.[2])
        return json({
          data: [
            { id: "m1", seq: 2, received_at: "2026-10-13T10:00:00Z", event: { type: "issues.opened" } },
            { id: "m2", seq: 1, received_at: "2026-10-13T09:00:00Z", event: { type: "push" } },
          ],
          next_cursor: null,
        });
      if (one) return json(inboxes.find((i) => (i as { id: string }).id === one[1]));
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("eventsText", () => {
  it("counts event types, or says every event", () => {
    expect(eventsText(["*"])).toBe("every event");
    expect(eventsText(["a"])).toBe("1 event type");
    expect(eventsText(["a", "b"])).toBe("2 event types");
  });
});

describe("Inboxes list", () => {
  it("shows name, counts, source, readers and last message from real data", async () => {
    render(<Inboxes />);
    await screen.findByText("loopway-github");
    const rows = (await screen.findAllByRole("row")).slice(1);
    expect(rows).toHaveLength(2);
    const [github, vercelRow] = rows.map((r) => within(r));
    await waitFor(() => expect(github!.getByText("2 event types · 2418 messages")).toBeTruthy());
    expect(github!.getByText("GitHub")).toBeTruthy();
    expect(github!.getByText("dev").getAttribute("href")).toBe("/dashboard/bots/b1");
    expect(github!.getByText("reviewer").getAttribute("href")).toBe("/dashboard/bots/b2");
    expect(github!.getByRole("group").getAttribute("aria-label")).toBe("3 delivered in 14 days");
    expect(github!.getByText(/\d+ d ago/)).toBeTruthy();
    expect(github!.queryByText("needs its secret")).toBeNull();

    expect(vercelRow!.getByText("needs its secret")).toBeTruthy();
    expect(vercelRow!.getByText("every event · 0 messages")).toBeTruthy();
    expect(vercelRow!.getByText("never")).toBeTruthy();
  });

  it("links Connect a source to the new-bot flow and each name to its page", async () => {
    render(<Inboxes />);
    expect((await screen.findByRole("link", { name: "Connect a source" })).getAttribute("href")).toBe(
      "/dashboard/bots/new",
    );
    expect((await screen.findByRole("link", { name: "loopway-github" })).getAttribute("href")).toBe(
      "/dashboard/inboxes/i1",
    );
  });

  it("scrolls the wide table in its own box", async () => {
    render(<Inboxes />);
    const table = await screen.findByRole("table");
    expect(table.parentElement!.className).toBe("scroll");
  });

  it("says so when there are no inboxes", async () => {
    inboxes = [];
    render(<Inboxes />);
    expect(await screen.findByText(/No inboxes yet/)).toBeTruthy();
  });
});

describe("Inbox page", () => {
  it("shows the URL, copies it, and lists events as toggles with the set ones on", async () => {
    const writeText = vi.fn(async () => {});
    Object.assign(navigator, { clipboard: { writeText } });
    render(<Inbox id="i1" />);
    const url = await screen.findByLabelText<HTMLInputElement>("Webhook URL");
    expect(url.value).toBe("https://loopway.test/api/webhooks/i1");
    fireEvent.click(screen.getByRole("button", { name: "Copy" }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("https://loopway.test/api/webhooks/i1"));
    const on = (name: string) => screen.getByRole<HTMLInputElement>("checkbox", { name }).checked;
    expect([on("issues"), on("push"), on("release")]).toEqual([true, true, false]);
    // A finished inbox has no setup steps.
    expect(screen.queryByText("Finish setting up this inbox")).toBeNull();
  });

  it("saves the toggled events", async () => {
    render(<Inbox id="i1" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "release" }));
    fireEvent.click(screen.getByRole("button", { name: "Save events" }));
    await screen.findByText("Saved.");
    const save = requests.find((r) => r.method === "PATCH")!;
    expect(save.path).toBe("/inboxes/i1");
    expect(save.body).toEqual({ config: { events: ["issues", "push", "release"] } });
  });

  it("shows the API's message when a save fails", async () => {
    patchReply = { status: 400, body: { error: { message: "events must be known" } } };
    render(<Inbox id="i1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Save events" }));
    expect(await screen.findByText("events must be known")).toBeTruthy();
  });

  it("won't save with no events", async () => {
    render(<Inbox id="i1" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: "issues" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "push" }));
    fireEvent.click(screen.getByRole("button", { name: "Save events" }));
    expect(await screen.findByText("Pick at least one event.")).toBeTruthy();
    expect(requests.some((r) => r.method === "PATCH")).toBe(false);
  });

  it("shows numbered setup steps for an inbox missing its sender-made secret, and saves the pasted one", async () => {
    render(<Inbox id="i2" />);
    await screen.findByText("Finish setting up this inbox");
    const steps = screen.getAllByRole("listitem");
    expect(steps.map((s) => s.querySelector(".step-n")?.textContent)).toEqual(["1", "2", "3"]);
    expect(screen.getByText("Add it in Vercel under Settings › Webhooks.")).toBeTruthy();
    expect(screen.getByText("rejecting deliveries")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Signing secret"), { target: { value: "whsec_abc" } });
    patchReply = { status: 200, body: { ...vercel, config: { secret: "whsec_abc", events: ["*"] } } };
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(screen.queryByText("Finish setting up this inbox")).toBeNull());
    expect(requests.find((r) => r.method === "PATCH")!.body).toEqual({ config: { secret: "whsec_abc" } });
  });

  it("shows the API's message when the secret is refused", async () => {
    patchReply = { status: 400, body: { error: { message: "secret is too short" } } };
    render(<Inbox id="i2" />);
    fireEvent.change(await screen.findByLabelText("Signing secret"), { target: { value: "x" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(await screen.findByText("secret is too short")).toBeTruthy();
  });

  it("lists recent messages and renames", async () => {
    render(<Inbox id="i1" />);
    expect(await screen.findByText("issues.opened")).toBeTruthy();
    expect(screen.getAllByText("push").length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "renamed" } });
    patchReply = { status: 200, body: inbox({ name: "renamed" }) };
    fireEvent.click(screen.getByRole("button", { name: "Rename" }));
    await screen.findByRole("heading", { name: "renamed" });
    expect(requests.find((r) => r.method === "PATCH")!.body).toEqual({ name: "renamed" });
  });

  it("deletes after confirming", async () => {
    vi.stubGlobal("confirm", () => true);
    const assign = vi.fn();
    vi.stubGlobal("location", { ...window.location, assign });
    render(<Inbox id="i1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Delete inbox" }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith("/dashboard/inboxes"));
    expect(requests.some((r) => r.method === "DELETE" && r.path === "/inboxes/i1")).toBe(true);
  });
});
