import { HARNESSES } from "@loopway/harnesses";
import { describe, expect, it } from "vitest";
import { sources } from "../src/sources.js";
import { createWeb } from "../src/ui.js";

describe("GET /llms.txt", () => {
  it("serves plain text that covers what bots, rules and the CLI are", async () => {
    const captured: string[] = [];
    const app = createWeb({ metrics: { capture: async (event) => void captured.push(event) } });
    const res = await app.request("/llms.txt");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/plain");
    const body = await res.text();
    expect(body).toMatch(/^# loopway/);
    for (const part of ["## How a bot's rules work", "loopway bots create", "loopway inbox create"]) {
      expect(body).toContain(part);
    }
    expect(captured).toEqual(["llms_txt_served"]);
  });

  it("names every agent and every source the code has", async () => {
    const body = await (await createWeb().request("/llms.txt")).text();
    for (const harness of HARNESSES) expect(body).toContain(`\`${harness.name}\``);
    for (const type of sources.types()) expect(body).toContain(`\`${type}\``);
  });
});
