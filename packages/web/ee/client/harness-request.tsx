import { useState } from "react";
import * as lw from "../../client/lw.js";

/**
 * The "Something else…" half of the new-bot harness picker: ask for a harness by its product page's URL. It sits
 * inside the bot form, so it sends from its own button rather than the form's submit.
 */
export function HarnessRequest() {
  const [url, setUrl] = useState("");
  const [requested, setRequested] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function send() {
    setError(null);
    setRequested(false);
    const r = await lw.api("/harnesses/requests", { method: "POST", body: { url } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return setError(await lw.message(r));
    setUrl("");
    setRequested(true);
  }

  return (
    <div className="field">
      <label htmlFor="harness-url">Link to its product page</label>
      <div className="input-wrap">
        <input
          id="harness-url"
          type="url"
          maxLength={500}
          placeholder="https://"
          value={url}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (url) void send();
            }
          }}
          onChange={(e) => {
            setUrl(e.target.value);
            setRequested(false);
          }}
        />
        <button className="btn btn-sm" type="button" disabled={!url} onClick={() => void send()}>
          Request it
        </button>
      </div>
      <p className="hint">
        {requested ? "Thanks, we've got it." : "Tell us which coding agent you want bots to run on next."}
      </p>
      {error && <p className="error">{error}</p>}
    </div>
  );
}
