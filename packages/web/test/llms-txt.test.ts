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
    // Look in the concept that lists each, since some names (`loopway`) also show up elsewhere.
    const concept = (name: string) => body.split("\n").find((line) => line.startsWith(`- **${name}**:`)) ?? "";
    for (const harness of HARNESSES) expect(concept("Bot")).toContain(`\`${harness.name}\``);
    for (const type of sources.types()) expect(concept("Inbox")).toContain(`\`${type}\``);
  });

  it("names the request's origin, or PUBLIC_BASE_URL when set, never a hard-coded host", async () => {
    const own = await (await createWeb().request("http://self.example:8080/llms.txt")).text();
    expect(own).toContain("http://self.example:8080/install.sh");
    expect(own).not.toContain("craftmill.dev");
    expect(own).not.toContain("{{base_url}}");
    const configured = createWeb({ publicBaseUrl: "https://lw.example.com/" });
    const body = await (await configured.request("http://internal:3000/llms.txt")).text();
    expect(body).toContain("https://lw.example.com/install.sh");
    expect(body).not.toContain("internal:3000");
  });
});
