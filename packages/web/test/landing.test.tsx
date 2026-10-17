// @vitest-environment jsdom
import { HARNESS_LABELS } from "@loopway/harnesses/labels";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import home from "../content/home.md";
import { track } from "../client/metrics.js";
import { agentList, AGENTS, LandingSections, parseHome } from "../client/landing.js";

vi.mock("../client/metrics.js", () => ({ track: vi.fn() }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const FIXTURE = `<!-- not on the page -->

## A runner {#top}

# Bots that *ask*.

Run by {agents}.

[Get started](/login)
[Read the docs](https://example.com/docs)

\`\`\`install
curl -fsSL https://example.com/install.sh | sh
  --continued
\`\`\`

## Parts {#how}

### From an event to work

Each part keeps one fact.

1. **Source** — Sends an event.
2. **Inbox** — Keeps it.

Our bots:

- **Level 3 · A bot starts it** — The bot asks.
  *A bot starts it. You answer it.*
- Just a line, no title.

[Again](/login)

\`\`\`cli
loopway login

loopway bots run
\`\`\`
`;

const draw = (md: string, agents?: readonly string[]) =>
  render(<LandingSections sections={parseHome(md, agents)} />).container;

describe("the landing page from markdown", () => {
  it("makes a section for each ## with its id and label, and drops what comes before the first", () => {
    const c = draw(FIXTURE);
    expect([...c.querySelectorAll("section")].map((s) => s.id)).toEqual(["top", "how"]);
    expect([...c.querySelectorAll(".lp-label")].map((l) => l.textContent)).toEqual(["A runner", "Parts"]);
    expect(c.textContent).not.toContain("not on the page");
  });

  it("makes # the headline and ### the section's heading", () => {
    draw(FIXTURE);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Bots that ask.");
    expect(h1.querySelector("em")?.textContent).toBe("ask");
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("From an event to work");
  });

  it("makes lists into columns: title, text, a footnote, a kicker before the dot, and an ordered list's numbers", () => {
    const c = draw(FIXTURE);
    const how = c.querySelector("#how")!;
    const [steps, bots] = [...how.querySelectorAll(".lp-items")];
    expect(steps!.tagName).toBe("OL");
    expect([...steps!.querySelectorAll(".lp-num")].map((n) => n.textContent)).toEqual(["01", "02"]);
    expect([...steps!.querySelectorAll(".lp-title")].map((t) => t.textContent)).toEqual(["Source", "Inbox"]);
    expect([...steps!.querySelectorAll(".lp-text")].map((t) => t.textContent)).toEqual([
      "Sends an event.",
      "Keeps it.",
    ]);

    const [first, second] = [...bots!.querySelectorAll("li")];
    expect(first!.querySelector(".lp-kicker")?.textContent).toBe("Level 3");
    expect(first!.querySelector(".lp-swatch.lp-level-3")).not.toBeNull();
    expect(first!.querySelector(".lp-title")?.textContent).toBe("A bot starts it");
    expect(first!.querySelector(".lp-note")?.textContent).toBe("A bot starts it. You answer it.");
    expect(second!.querySelector(".lp-title")).toBeNull();
    expect(second!.querySelector(".lp-text")?.textContent).toBe("Just a line, no title.");
    // The paragraph ending in a colon is the list's caption, not prose.
    expect(how.querySelector(".lp-caption")?.textContent).toBe("Our bots");
  });

  it("makes links alone on their lines into buttons, the first in a section solid", () => {
    const c = draw(FIXTURE);
    const top = within(c.querySelector<HTMLElement>("#top")!);
    expect(top.getByRole("link", { name: "Get started" }).className).toBe("btn");
    expect(top.getByRole("link", { name: "Read the docs" }).className).toBe("btn btn-quiet");
    const how = within(c.querySelector<HTMLElement>("#how")!);
    expect(how.getByRole("link", { name: "Again" }).className).toBe("btn");
  });

  it("makes fenced blocks into wells labelled by their info string, with a prompt on each command", () => {
    const c = draw(FIXTURE);
    const wells = [...c.querySelectorAll(".lp-well")];
    expect(wells.map((w) => w.querySelector(".lp-well-label")?.textContent)).toEqual(["install", "cli"]);
    expect(wells[0]!.querySelector("pre")?.textContent).toBe(
      "curl -fsSL https://example.com/install.sh | sh\n  --continued",
    );
    expect([...wells[0]!.querySelectorAll(".lp-cmd")].map((l) => l.textContent)).toEqual([
      "curl -fsSL https://example.com/install.sh | sh\n",
    ]);
    // A blank line between commands gets no prompt.
    expect([...wells[1]!.querySelectorAll(".lp-cmd")].map((l) => l.textContent)).toEqual([
      "loopway login\n",
      "loopway bots run",
    ]);
  });

  it("gives each well a copy button outside the code, so selecting the code never picks it up", () => {
    const c = draw(FIXTURE);
    for (const w of c.querySelectorAll(".lp-well")) {
      expect(w.querySelector(".lp-well-copy")?.textContent).toBe("Copy");
      expect(w.querySelector("pre")?.contains(w.querySelector(".lp-well-copy"))).toBe(false);
    }
  });

  it("copies a well's code without the prompt, and says so", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const c = draw(FIXTURE);
    const button = c.querySelector<HTMLButtonElement>(".lp-well-copy")!;
    fireEvent.click(button);
    await waitFor(() => expect(button.textContent).toBe("Copied"));
    expect(writeText).toHaveBeenCalledWith("curl -fsSL https://example.com/install.sh | sh\n  --continued");
    expect(track).toHaveBeenCalledWith("landing_well_copied", { well: "install" });
  });

  it("records a failed copy and leaves the label alone", async () => {
    Object.assign(navigator, { clipboard: { writeText: vi.fn().mockRejectedValue(new Error("denied")) } });
    const c = draw(FIXTURE);
    const button = c.querySelector<HTMLButtonElement>(".lp-well-copy")!;
    fireEvent.click(button);
    await waitFor(() => expect(track).toHaveBeenCalledWith("landing_well_copy_failed", { well: "install" }));
    expect(button.textContent).toBe("Copy");
  });

  it("leaves an empty slot for the figures of top, threads and dashboard", () => {
    const c = draw(FIXTURE);
    expect(c.querySelector('#top .lp-figure[data-figure="top"]')?.childNodes.length).toBe(0);
    expect(c.querySelector("#how .lp-figure")).toBeNull();
  });

  it("names the agents from the harness labels, so a new one shows up in the text", () => {
    expect(AGENTS).toEqual(Object.values(HARNESS_LABELS));
    expect(draw(FIXTURE).textContent).toContain(`Run by ${agentList(AGENTS)}.`);
    cleanup();
    const more = [...AGENTS, "Gemini"];
    expect(draw(FIXTURE, more).textContent).toContain(`Run by ${agentList(more)}.`);
    expect(agentList(more)).toMatch(/ or Gemini$/);
  });

  it("joins agent names as A, B, C or D", () => {
    expect(agentList(["A"])).toBe("A");
    expect(agentList(["A", "B"])).toBe("A or B");
    expect(agentList(["A", "B", "C", "D"])).toBe("A, B, C or D");
  });
});

describe("content/home.md", () => {
  const sections = parseHome(home);

  it("has the page's sections in order", () => {
    expect(sections.map((s) => s.id)).toEqual([
      "top",
      "listens",
      "levels",
      "bots",
      "how",
      "threads",
      "runners",
      "dashboard",
      "api",
      "sources",
      "start",
      "colophon",
    ]);
  });

  it("names every agent in the lede, and says nothing of a sandbox", () => {
    const c = draw(home);
    expect(c.querySelector("#top")!.textContent).toContain(agentList(AGENTS));
    expect(c.textContent).not.toMatch(/sandbox/i);
  });
});

describe("the threads figure", () => {
  it("shows a deploy-medic thread asking a person a question, with none of our real bot names", () => {
    const figure = draw(home).querySelector('[data-figure="threads"]')!;
    expect(figure.textContent).toContain("deploy-medic · thread");
    expect(figure.textContent).toContain("Roll back to eb83c73");
    expect(figure.textContent).toContain("tail -f ~/.loopway/threads/");
    for (const name of [
      "loopway-dev",
      "loopway-review",
      "loopway-epic",
      "loopway-requests",
      "prod-deploy-errors",
      "model-updater",
      "call-learnings",
    ])
      expect(figure.textContent).not.toContain(name);
  });
});
