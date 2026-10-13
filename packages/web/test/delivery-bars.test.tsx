// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeliveryBars } from "../client/delivery-bars.js";
import type { BotActivity } from "../client/lw.js";

function activity(days: [string, number][]): BotActivity {
  return {
    bot_id: "b1",
    days: days.map(([date, delivered]) => ({ date, delivered })),
    delivered: days.reduce((n, [, d]) => n + d, 0),
    last_delivery_at: null,
    runs: 0,
    median_wait_seconds: null,
  };
}

const week = activity([
  ["2026-10-10", 1],
  ["2026-10-11", 0],
  ["2026-10-12", 4],
]);

afterEach(cleanup);

describe("DeliveryBars", () => {
  it("shows an ellipsis while activity is loading", () => {
    render(<DeliveryBars activity={undefined} days={14} />);
    expect(screen.getByText("…")).toBeTruthy();
  });

  it("says so when there are no deliveries in the window", () => {
    render(<DeliveryBars activity={activity([["2026-10-12", 0]])} days={14} />);
    expect(screen.getByText("No deliveries")).toBeTruthy();
  });

  it("only counts the last `days` days", () => {
    render(
      <DeliveryBars
        activity={activity([
          ["2026-10-10", 9],
          ["2026-10-12", 0],
        ])}
        days={1}
      />,
    );
    expect(screen.getByText("No deliveries")).toBeTruthy();
  });

  it("labels the max with the busiest day", () => {
    render(<DeliveryBars activity={week} days={14} />);
    expect(screen.getByText("max 4")).toBeTruthy();
    expect(screen.getByRole("group").getAttribute("aria-label")).toBe("5 delivered in 3 days");
  });

  it("gives each day an aria-label", () => {
    render(<DeliveryBars activity={week} days={14} />);
    const labels = screen.getAllByRole("img").map((el) => el.getAttribute("aria-label"));
    expect(labels).toEqual(["Oct 10 · 1 delivered", "Oct 11 · 0 delivered", "Oct 12 · 4 delivered"]);
  });

  it("falls back to the raw string for a malformed date", () => {
    render(<DeliveryBars activity={activity([["not-a-date", 2]])} days={14} />);
    expect(screen.getByRole("img").getAttribute("aria-label")).toBe("not-a-date · 2 delivered");
  });

  describe("tooltip", () => {
    const tip = () => document.querySelector(".bar-tip");
    const col = () => screen.getAllByRole("img")[2]!;

    it("shows on hover and hides on leave", () => {
      render(<DeliveryBars activity={week} days={14} />);
      expect(tip()).toBeNull();
      fireEvent.mouseEnter(col());
      expect(tip()?.textContent).toBe("Oct 12 · 4 delivered");
      fireEvent.mouseLeave(col());
      expect(tip()).toBeNull();
    });

    it("shows on focus and hides on blur", () => {
      render(<DeliveryBars activity={week} days={14} />);
      fireEvent.focus(col());
      expect(tip()?.textContent).toBe("Oct 12 · 4 delivered");
      fireEvent.blur(col());
      expect(tip()).toBeNull();
    });

    it("hides on scroll", () => {
      render(<DeliveryBars activity={week} days={14} />);
      fireEvent.focus(col());
      expect(tip()).not.toBeNull();
      act(() => {
        document.body.dispatchEvent(new Event("scroll"));
      });
      expect(tip()).toBeNull();
    });
  });
});
