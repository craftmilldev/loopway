import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/client.js";
import { sessionTools } from "../src/bots/tools.js";

describe("session tools on an outdated runner", () => {
  it("turn a 426 into a one-line tool error, mark the runner outdated and record it once", async () => {
    const events: [string, unknown][] = [];
    const onOutdated = vi.fn();
    const tools = sessionTools(
      {
        get: async () => {
          throw new Error("unused");
        },
        patch: async () => {
          throw new ApiError(426, "cli_outdated", "too old");
        },
      },
      { capture: async (e, p) => void events.push([e, p]) },
      onOutdated,
    );
    const link = tools.find((t) => t.name === "link")!;
    for (let i = 0; i < 2; i++)
      await expect(link.call("t1", { subject: "linear/CRA-1" })).rejects.toThrow(
        /too old for the server.*loopway update/,
      );
    expect(onOutdated).toHaveBeenCalledTimes(2);
    expect(events.filter(([e]) => e === "cli_outdated_seen")).toEqual([["cli_outdated_seen", { where: "mcp" }]]);
  });
});
