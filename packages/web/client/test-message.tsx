import { useState } from "react";
import * as lw from "./lw.js";

/**
 * Sends an inbox a sample message of its source, so a new user sees a bot run without setting up the sender first.
 * The server records `test_message_sent` / `test_message_failed`, so nothing is tracked here.
 */
export function TestMessageButton({ inboxId, from }: { inboxId: string; from: "inbox_page" | "zero_state" }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);

  async function send() {
    setBusy(true);
    setResult(null);
    const r = await lw.api("/inboxes/" + encodeURIComponent(inboxId) + "/test", { method: "POST", body: { from } });
    setBusy(false);
    if (r.status === 401) return lw.expired(r);
    setResult(
      r.ok
        ? { ok: true, text: "Sent. Watch the terminal your runner is in." }
        : { ok: false, text: await lw.message(r) },
    );
  }

  return (
    <div className="form-actions">
      <button className="btn btn-md" type="button" disabled={busy} onClick={() => void send()}>
        Send a test message
      </button>
      {result && (
        <span className="muted" role={result.ok ? "status" : "alert"}>
          {result.text}
        </span>
      )}
    </div>
  );
}
