import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the marketing page", () => {
  const html = readFileSync(new URL("../public/index.html", import.meta.url), "utf8");

  it("is one static file with a title and no script", () => {
    expect(html).toContain("<title>loopway</title>");
    expect(html).not.toContain("<script");
  });

  it("is what vercel.json serves, with no build step", () => {
    const config = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8")) as Record<
      string,
      unknown
    >;
    expect(config.outputDirectory).toBe("public");
    expect(config.buildCommand).toBeNull();
    expect(config.crons).toBeUndefined();
  });
});
