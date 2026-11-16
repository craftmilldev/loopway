import { render } from "ink-testing-library";
import { setTimeout as sleep } from "node:timers/promises";
import { stripVTControlCharacters as plain } from "node:util";
import { describe, expect, it } from "vitest";
import { Choose, Prompt } from "../src/setup-io.js";

const press = async (app: ReturnType<typeof render>, key: string) => {
  app.stdin.write(key);
  await sleep(20);
};

describe("the setup questions", () => {
  it("Choose moves with the arrows and answers with Enter", async () => {
    let answer = "";
    const app = render(
      <Choose
        question="Pick"
        options={[
          { value: "a", label: "Alpha" },
          { value: "b", label: "Beta" },
        ]}
        onDone={(v) => (answer = v)}
      />,
    );
    await sleep(20);
    expect(plain(app.lastFrame() ?? "")).toContain("❯ Alpha");
    await press(app, "\u001B[B");
    await press(app, "\r");
    expect(answer).toBe("b");
    app.unmount();
  });

  it("Prompt edits text, and shows a secret as dots", async () => {
    let answer = "";
    const app = render(<Prompt question="Token" secret onDone={(v) => (answer = v)} />);
    await sleep(20);
    await press(app, "abc");
    expect(plain(app.lastFrame() ?? "")).toContain("•••");
    expect(plain(app.lastFrame() ?? "")).not.toContain("abc");
    await press(app, "\r");
    expect(answer).toBe("abc");
    app.unmount();
  });
});
