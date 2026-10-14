// @vitest-environment jsdom
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as lw from "../client/lw.js";
import { updatedText } from "../client/updated.js";

let visibility: "visible" | "hidden";
let calls: string[];
let respond: (path: string) => Promise<Response>;
let renders: number;

const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }));
const setVisibility = (v: "visible" | "hidden") => {
  visibility = v;
  document.dispatchEvent(new Event("visibilitychange"));
};

function Probe({ path = "/bots", poll }: { path?: string; poll?: number | false }) {
  const { data } = lw.useGet<{ n: number }>(path, true, poll === undefined ? undefined : { poll });
  renders++;
  return <div>{data ? "n=" + data.n : "loading"}</div>;
}

// Lets pending promises (fetch, text(), state updates) settle without moving the clock.
const settle = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const tick = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  calls = [];
  renders = 0;
  respond = () => json({ n: 1 });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  vi.stubGlobal(
    "fetch",
    vi.fn((path: string) => {
      calls.push(path);
      return respond(path);
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("polling", () => {
  it("refetches on the interval while visible", async () => {
    const { getByText } = render(<Probe />);
    await settle();
    expect(calls).toHaveLength(1);
    respond = () => json({ n: 2 });
    await tick(lw.POLL_MS);
    expect(calls).toHaveLength(2);
    expect(getByText("n=2")).toBeTruthy();
  });

  it("uses a different interval, and none when turned off", async () => {
    render(<Probe poll={1000} />);
    await settle();
    await tick(3000);
    expect(calls).toHaveLength(4);
    cleanup();
    calls = [];
    render(<Probe poll={false} />);
    await settle();
    await tick(10 * lw.POLL_MS);
    expect(calls).toHaveLength(1);
  });

  it("makes no requests while hidden, and refreshes at once on return if stale", async () => {
    render(<Probe />);
    await settle();
    setVisibility("hidden");
    await tick(5 * lw.POLL_MS);
    expect(calls).toHaveLength(1);
    setVisibility("visible");
    await settle();
    expect(calls).toHaveLength(2);
    await tick(lw.POLL_MS);
    expect(calls).toHaveLength(3);
  });

  it("does not refresh on return when the data is fresher than the interval", async () => {
    render(<Probe />);
    await settle();
    await tick(5000);
    setVisibility("hidden");
    setVisibility("visible");
    await settle();
    expect(calls).toHaveLength(1);
    await tick(lw.POLL_MS - 5000);
    expect(calls).toHaveLength(2);
  });

  it("never overlaps a refresh with one still in flight", async () => {
    let release: () => void = () => {};
    render(<Probe />);
    await settle();
    respond = () => new Promise<Response>((resolve) => (release = () => resolve(new Response('{"n":1}'))));
    await tick(lw.POLL_MS);
    expect(calls).toHaveLength(2);
    await tick(5 * lw.POLL_MS);
    expect(calls).toHaveLength(2);
    respond = () => json({ n: 1 });
    release();
    await settle();
    await tick(lw.POLL_MS);
    expect(calls).toHaveLength(3);
  });

  it("keeps the data, backs off on failure, and resets after a success", async () => {
    const { getByText } = render(<Probe />);
    await settle();
    respond = () => json({ error: {} }, 500);
    await tick(lw.POLL_MS); // fails, next wait doubles to 30 s
    expect(calls).toHaveLength(2);
    expect(getByText("n=1")).toBeTruthy();
    await tick(lw.POLL_MS);
    expect(calls).toHaveLength(2);
    await tick(lw.POLL_MS); // 30 s after the failure: fails again, next wait 60 s
    expect(calls).toHaveLength(3);
    respond = () => json({ n: 3 });
    await tick(60_000);
    expect(calls).toHaveLength(4);
    expect(getByText("n=3")).toBeTruthy();
    await tick(lw.POLL_MS); // reset
    expect(calls).toHaveLength(5);
  });

  it("caps the wait at two minutes", async () => {
    render(<Probe />);
    await settle();
    respond = () => Promise.reject(new Error("offline"));
    for (const wait of [15_000, 30_000, 60_000, 120_000]) await tick(wait);
    expect(calls).toHaveLength(5);
    await tick(120_000);
    expect(calls).toHaveLength(6);
  });

  it("does not re-render when the response is unchanged", async () => {
    render(<Probe />);
    await settle();
    const before = renders;
    await tick(lw.POLL_MS);
    await tick(lw.POLL_MS);
    expect(calls).toHaveLength(3);
    expect(renders).toBe(before);
  });

  it("stops when the page goes away", async () => {
    const { unmount } = render(<Probe />);
    await settle();
    unmount();
    await tick(3 * lw.POLL_MS);
    expect(calls).toHaveLength(1);
  });
});

describe("updatedText", () => {
  it("counts up", () => {
    const now = 1_000_000;
    expect(updatedText(now - 2000, now)).toBe("updated just now");
    expect(updatedText(now - 12_000, now)).toBe("updated 12 s ago");
    expect(updatedText(now - 125_000, now)).toBe("updated 2 min ago");
  });
});
