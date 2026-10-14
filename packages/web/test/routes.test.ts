import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { createWeb } from "../src/ui.js";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

/** The org-relative paths the client renders (client/main.tsx) and links to in the header (client/layout.tsx). */
function clientOrgPaths() {
  const routed = [...read("../client/main.tsx").matchAll(/rest === "([^"]+)"/g)].map((m) => m[1]!);
  const linked = [...read("../client/layout.tsx").matchAll(/href: base \+ "([^"]+)"/g)].map((m) => m[1]!);
  return [...new Set(["", ...routed, ...linked])];
}

describe("pages the client renders", () => {
  it("finds the routes and nav links it checks", () => {
    expect(clientOrgPaths()).toEqual(expect.arrayContaining(["/bots", "/inboxes", "/members", "/runners"]));
  });

  it("are all served as the app shell on a full page load", async () => {
    const app = createWeb();
    for (const rest of clientOrgPaths()) {
      const res = await app.request("/acme" + rest);
      expect(res.status, "/acme" + rest).toBe(200);
      expect(res.headers.get("content-type")).toMatch(/html/);
    }
    for (const path of ["/orgs/new", "/login", "/dashboard", "/dashboard/bots", "/dashboard/inboxes"]) {
      expect((await app.request(path)).status, path).toBe(200);
    }
  });
});
