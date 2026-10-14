import { useEffect, useState } from "react";
import * as lw from "./lw.js";

/** "updated 12 s ago", "updated 3 min ago". */
export function updatedText(at: number, now = Date.now()) {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 5) return "updated just now";
  if (s < 60) return `updated ${s} s ago`;
  return `updated ${Math.floor(s / 60)} min ago`;
}

/** A small muted note on how fresh the page's data is. It ticks on its own, so the page around it doesn't re-render. */
export function Updated() {
  const at = lw.useUpdatedAt();
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  if (at === null) return null;
  return (
    <span className="muted updated" aria-live="off">
      {updatedText(at, now)}
    </span>
  );
}
