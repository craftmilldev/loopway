import { useEffect, useRef, useState, type FormEvent } from "react";
import { Layout } from "./layout.js";
import * as lw from "./lw.js";

export function Login() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);

  // A stored token that still works skips the form; a stale one is dropped quietly.
  useEffect(() => {
    if (!lw.token()) return;
    lw.api("/me")
      .catch(() => null)
      .then((r) => {
        if (r && r.ok) location.replace("/dashboard");
        else lw.clear();
      });
  }, []);

  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
  }, [step]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (step === "email") {
        const r = await lw.api("/auth/login", { method: "POST", body: { email }, auth: false });
        if (!r.ok) return setError(await lw.message(r));
        setStep("code");
      } else {
        const r = await lw.api("/auth/verify", { method: "POST", body: { email, code }, auth: false });
        if (!r.ok) return setError(await lw.message(r));
        lw.save((await r.json()).token);
        location.replace("/dashboard");
      }
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout title="Log in · loopway" nav={<a href="/">Home</a>}>
      <div className="narrow">
        <p className="eyebrow">log in</p>
        <h1>Log in</h1>
        {step === "code" && (
          <p className="hint muted" style={{ marginTop: 12 }}>
            If that address can receive mail, a code is on its way.
          </p>
        )}
        <form onSubmit={submit} style={{ marginTop: 24 }}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <div className="input-wrap">
              <input
                id="email"
                type="email"
                required
                autoComplete="email"
                autoFocus
                readOnly={step === "code"}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
          </div>
          {step === "code" && (
            <div className="field">
              <label htmlFor="code">Login code</label>
              <div className="input-wrap">
                <input
                  id="code"
                  ref={codeInput}
                  required
                  autoComplete="one-time-code"
                  autoCapitalize="characters"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
              </div>
            </div>
          )}
          <div className="form-actions">
            <button className="btn" type="submit" disabled={busy}>
              {step === "email" ? "Send code" : "Verify"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
    </Layout>
  );
}
