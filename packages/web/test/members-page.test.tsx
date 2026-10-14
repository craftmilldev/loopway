// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { track } from "../client/metrics.js";
import { MembersPage } from "../client/members.js";

vi.mock("../client/metrics.js", () => ({ track: vi.fn(), identify: vi.fn(), reset: vi.fn() }));

const mine = { id: "o1", slug: "me", name: "me", personal: true };
const team = { id: "o2", slug: "craftmill", name: "craftmill", personal: false };
const me = { id: "u1", username: "me", email: "me@x.test" };
const pat = { id: "u2", username: "pat", email: "pat@x.test" };

let requests: { path: string; method: string; body?: unknown }[];
let members: { members: object[]; pending: string[] };
let reply: { status: number; body: unknown } | null;
let assigned: string[];

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("loopway_token", "t");
  requests = [];
  assigned = [];
  reply = null;
  members = { members: [me, pat], pending: ["new@x.test"] };
  const real = window.location;
  vi.stubGlobal("location", {
    origin: real.origin,
    get pathname() {
      return real.pathname;
    },
    get search() {
      return real.search;
    },
    get hash() {
      return real.hash;
    },
    replace: () => {},
    assign: (to: string) => assigned.push(to),
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (apiPath: string, init?: { method?: string; body?: string }) => {
      const path = apiPath.replace(/^\/api/, "");
      const method = init?.method ?? "GET";
      requests.push({ path, method, body: init?.body ? JSON.parse(init.body) : undefined });
      const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
      if (path === "/me") return json({ id: "u1", email: "me@x.test", name: "Me", username: "me" });
      if (path === "/orgs") return json({ data: [mine, team] });
      if (method !== "GET" && reply) return json(reply.body, reply.status);
      if (path.endsWith("/members") && method === "GET") return json(members);
      if (method === "DELETE") return new Response(null, { status: 204 });
      return new Response("{}", { status: 404 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

const open = (slug: string) => window.history.replaceState(null, "", `/${slug}/members`);

describe("MembersPage", () => {
  it("lists members and pending emails", async () => {
    open("craftmill");
    render(<MembersPage />);
    await screen.findByText("pat");
    expect(screen.getByText("pat@x.test")).toBeTruthy();
    expect(screen.getByText("new@x.test")).toBeTruthy();
    expect(screen.getByText("pending")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Leave org me" })).toBeTruthy();
    expect(requests.some((r) => r.path === "/orgs/craftmill/members" && r.method === "GET")).toBe(true);
    await waitFor(() =>
      expect(track).toHaveBeenCalledWith("members_viewed", { members: 2, pending: 1, personal: false }),
    );
  });

  it("adds a member and says so", async () => {
    open("craftmill");
    reply = { status: 201, body: { members: [me, pat], pending: [] } };
    render(<MembersPage />);
    await screen.findByText("pat");
    fireEvent.change(screen.getByLabelText("Add by email"), { target: { value: "Pat@X.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await screen.findByText("Added Pat@X.test.");
    const post = requests.find((r) => r.method === "POST");
    expect(post).toEqual({ path: "/orgs/craftmill/members", method: "POST", body: { email: "Pat@X.test" } });
    expect(track).toHaveBeenCalledWith("member_added", { result: "member" });
  });

  it("shows an unknown email as pending", async () => {
    open("craftmill");
    reply = { status: 201, body: { members: [me], pending: ["new@x.test"] } };
    render(<MembersPage />);
    await screen.findByText("pat");
    fireEvent.change(screen.getByLabelText("Add by email"), { target: { value: "new@x.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    await screen.findByText("new@x.test is pending until they sign up.");
    expect(track).toHaveBeenCalledWith("member_added", { result: "pending" });
  });

  it("shows the API's error in words", async () => {
    open("craftmill");
    reply = { status: 400, body: { error: { code: "invalid_request", message: "Invalid request" } } };
    render(<MembersPage />);
    await screen.findByText("pat");
    fireEvent.change(screen.getByLabelText("Add by email"), { target: { value: "a@b.test" } });
    fireEvent.click(screen.getByRole("button", { name: "Add member" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Invalid request");
    expect(track).toHaveBeenCalledWith("member_add_rejected", { status: 400, code: "invalid_request" });
  });

  it("removes a member and a pending email after confirming", async () => {
    open("craftmill");
    const ask = vi.fn(() => true);
    vi.stubGlobal("confirm", ask);
    render(<MembersPage />);
    await screen.findByText("pat");
    fireEvent.click(screen.getByRole("button", { name: "Remove pat" }));
    await screen.findByText("Removed pat.");
    expect(ask).toHaveBeenCalledWith("Remove pat from craftmill?");
    expect(requests).toContainEqual({ path: "/orgs/craftmill/members/u2", method: "DELETE", body: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Remove new@x.test" }));
    await screen.findByText("Removed new@x.test.");
    expect(requests.map((r) => r.path)).toContain("/orgs/craftmill/members/pending?email=new%40x.test");
  });

  it("does nothing when the confirmation is declined", async () => {
    open("craftmill");
    vi.stubGlobal("confirm", () => false);
    render(<MembersPage />);
    await screen.findByText("pat");
    fireEvent.click(screen.getByRole("button", { name: "Remove pat" }));
    expect(requests.some((r) => r.method === "DELETE")).toBe(false);
    expect(track).toHaveBeenCalledWith("member_remove_cancelled", { self: false, pending: false });
  });

  it("leaves the org and goes to the personal org", async () => {
    open("craftmill");
    vi.stubGlobal("confirm", () => true);
    render(<MembersPage />);
    await screen.findByText("pat");
    fireEvent.click(screen.getByRole("button", { name: "Leave org me" }));
    await waitFor(() => expect(assigned).toEqual(["/me"]));
    expect(localStorage.getItem("loopway_last_org")).toBe("me");
  });

  it("shows the error instead of leaving as the last member", async () => {
    open("craftmill");
    members = { members: [me], pending: [] };
    reply = {
      status: 409,
      body: { error: { code: "last_member", message: "An org's last member can't be removed or leave" } },
    };
    vi.stubGlobal("confirm", () => true);
    render(<MembersPage />);
    await screen.findByText("me@x.test");
    fireEvent.click(screen.getByRole("button", { name: "Leave org me" }));
    expect((await screen.findByRole("alert")).textContent).toContain("last member");
    expect(assigned).toEqual([]);
    expect(track).toHaveBeenCalledWith("member_remove_rejected", { status: 409, code: "last_member" });
  });

  it("shows only the owner of a personal org, with no add form", async () => {
    open("me");
    members = { members: [me], pending: [] };
    render(<MembersPage />);
    await screen.findByText("me@x.test");
    expect(screen.getByText("Personal orgs can't have other members.")).toBeTruthy();
    expect(screen.queryByLabelText("Add by email")).toBeNull();
    const table = within(screen.getByRole("table"));
    expect(table.queryByRole("button")).toBeNull();
  });
});
