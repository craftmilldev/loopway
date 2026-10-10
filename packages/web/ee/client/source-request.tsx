import { useState } from "react";
import * as lw from "../../client/lw.js";

/**
 * The "Something else…" half of the inbox create form: ask for a webhook source loopway doesn't have.
 * `fields` goes inside the form; call `send` from its submit handler.
 */
export function useSourceRequest(onError: (message: string) => void) {
  const [wanted, setWanted] = useState("");
  const [requested, setRequested] = useState(false);

  async function send() {
    setRequested(false);
    const r = await lw.api("/sources/requests", { method: "POST", body: { description: wanted } });
    if (r.status === 401) return lw.expired(r);
    if (!r.ok) return onError(await lw.message(r));
    setWanted("");
    setRequested(true);
  }

  const fields = (
    <>
      <div className="field">
        <label htmlFor="wanted">Which webhook do you want?</label>
        <div className="input-wrap">
          <input
            id="wanted"
            required
            maxLength={500}
            placeholder="e.g. Linear, https://linear.app/developers/webhooks"
            value={wanted}
            onChange={(e) => {
              setWanted(e.target.value);
              setRequested(false);
            }}
          />
        </div>
        <p className="hint">
          {requested
            ? "Thanks, we've got it. We'll open an issue for it on loopway's GitHub."
            : "Name the service, and link its webhook docs if you have them."}
        </p>
      </div>
      <div className="form-actions">
        <button className="btn" type="submit">
          Request it
        </button>
      </div>
    </>
  );

  return { fields, send };
}
