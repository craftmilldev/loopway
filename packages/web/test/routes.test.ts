import { describe, expect, it } from "vitest";
import { createWeb } from "../src/ui.js";

describe("pages", () => {
  it("serves the landing page and nothing else as a page", async () => {
    const app = createWeb();
    const home = await app.request("/");
    expect(home.status).toBe(200);
    expect(home.headers.get("content-type")).toMatch(/html/);
    for (const path of ["/login", "/dashboard", "/acme", "/acme/inboxes"]) {
      expect((await app.request(path)).status, path).toBe(404);
    }
  });
});
