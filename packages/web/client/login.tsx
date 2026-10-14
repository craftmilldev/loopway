import { useEffect, useRef, useState, type FormEvent } from "react";
import { Layout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

export function Login() {
  const [step, setStep] = useState<"email" | "code" | "username">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [username, setUsername] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const codeInput = useRef<HTMLInputElement>(null);
  const usernameInput = useRef<HTMLInputElement>(null);

  // A stored token that still works skips the form; a stale one is dropped quietly.
  useEffect(() => {
    if (!lw.token()) return;
    void lw
      .api("/me")
      .catch(() => null)
      .then(async (r) => {
        if (!r || !r.ok) return lw.clear();
        // A signup that stopped before choosing a username picks up here.
        const me = (await r.json().catch(() => null)) as { username?: string | null } | null;
        if (me && !me.username) setStep("username");
        else location.replace("/dashboard");
      });
  }, []);

  useEffect(() => {
    if (step === "code") codeInput.current?.focus();
    if (step === "username") usernameInput.current?.focus();
  }, [step]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (step === "username" && !code) {
        // A user who already has a session but never picked a username (made before signup asked for one).
        const r = await lw.api("/me/username", { method: "PATCH", body: { username } });
        if (!r.ok) {
          track("username_form_rejected", { status: r.status });
          return setError(await lw.message(r));
        }
        location.replace("/dashboard");
      } else if (step === "email") {
        const r = await lw.api("/auth/login", { method: "POST", body: { email }, auth: false });
        if (!r.ok) return setError(await lw.message(r));
        setStep("code");
      } else {
        // An existing account ignores the username; an unknown email is asked for one and the same code is sent again.
        const r = await lw.api("/auth/verify", {
          method: "POST",
          body: { email, code, ...(step === "username" && { username }) },
          auth: false,
        });
        if (!r.ok) {
          if (step === "code" && (await lw.errorCode(r)) === "username_required") {
            track("username_form_shown");
            return setStep("username");
          }
          if (step === "username") track("username_form_rejected", { status: r.status });
          return setError(await lw.message(r));
        }
        const body = (await r.json()) as { token: string };
        lw.save(body.token);
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
        <p className="eyebrow">{step === "username" ? "welcome" : "log in"}</p>
        <h1>{step === "username" ? "Pick a username" : "Log in"}</h1>
        {step === "username" && (
          <p className="hint muted" style={{ marginTop: 12 }}>
            Lowercase letters, numbers and hyphens, 2-39 characters. It names your personal org, and you can change it
            later.
          </p>
        )}
        {step === "code" && (
          <p className="hint muted" style={{ marginTop: 12 }}>
            If that address can receive mail, a code is on its way.
          </p>
        )}
        <form onSubmit={(e) => void submit(e)} style={{ marginTop: 24 }}>
          {step === "username" ? (
            <div className="field">
              <label htmlFor="username">Username</label>
              <div className="input-wrap">
                <input
                  id="username"
                  ref={usernameInput}
                  required
                  autoComplete="username"
                  autoCapitalize="none"
                  spellCheck={false}
                  value={username}
                  onChange={(e) => setUsername(e.target.value.toLowerCase())}
                />
              </div>
            </div>
          ) : (
            <>
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
            </>
          )}
          <div className="form-actions">
            <button className="btn" type="submit" disabled={busy}>
              {step === "email" ? "Send code" : step === "code" ? "Verify" : "Continue"}
            </button>
          </div>
          {error && <p className="error">{error}</p>}
        </form>
      </div>
    </Layout>
  );
}
