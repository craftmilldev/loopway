import { render } from "ink-testing-library";
import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it } from "vitest";
import { Choose, Prompt } from "../src/setup-io.js";

describe("the setup questions as drawn", () => {
  it("Choose marks the option at the cursor", () => {
    const app = render(<Choose question="Pick" options={[{ label: "Alpha" }, { label: "Beta" }]} at={1} />);
    const screen = plain(app.lastFrame() ?? "");
    expect(screen).toContain("  Alpha");
    expect(screen).toContain("❯ Beta");
    app.unmount();
  });

  it("Prompt shows a secret as dots", () => {
    const app = render(<Prompt question="Token" secret input={{ value: "abc", cursor: 3 }} />);
    expect(plain(app.lastFrame() ?? "")).toContain("•••");
    expect(plain(app.lastFrame() ?? "")).not.toContain("abc");
    app.unmount();
  });
});
