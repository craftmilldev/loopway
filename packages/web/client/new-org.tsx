import { useEffect, useState, type FormEvent } from "react";
import { Layout } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

/** How long typing pauses before the slug is checked, in milliseconds. */
const CHECK_DELAY = 300;

/** `/orgs/new`: the form for a shared org. The slug is checked as it's typed, so "taken" shows before submit. */
export function NewOrg() {
  const me = lw.useMe();
  const [slug, setSlug] = useState("");
  const [name, setName] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [available, setAvailable] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setAvailable(false);
    setProblem(null);
    if (!slug) return;
    let stale = false;
    const timer = setTimeout(() => {
      void lw
        .api("/orgs/" + encodeURIComponent(slug) + "/available")
        .then(async (r) => {
          if (stale) return;
          if (!r.ok) return setProblem(await lw.message(r));
          const body = (await r.json()) as { available: boolean; reason?: string; message?: string };
          setAvailable(body.available);
          setProblem(body.available ? null : (body.message ?? "That slug can't be used"));
          if (!body.available) track("org_slug_unavailable", { reason: body.reason ?? "unknown" });
        })
        .catch(() => undefined);
    }, CHECK_DELAY);
    return () => {
      stale = true;
      clearTimeout(timer);
    };
  }, [slug]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const r = await lw.api("/orgs", { method: "POST", body: { slug, ...(name.trim() && { name: name.trim() }) } });
      if (!r.ok) {
        track("org_form_rejected", { status: r.status, code: (await lw.errorCode(r)) ?? "unknown" });
        return setError(await lw.message(r));
      }
      track("org_form_created", { named: !!name.trim() });
      lw.rememberOrg(slug);
      location.assign("/" + encodeURIComponent(slug));
    } catch {
      setError("Could not reach the server.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Layout title="New org · loopway" nav={<a href="/dashboard">Dashboard</a>}>
      <div className="narrow">
        <p className="eyebrow">new org</p>
        <h1>Start an org</h1>
        <p className="hint muted" style={{ marginTop: 12 }}>
          A shared org holds bots and inboxes for the people in it. Lowercase letters, numbers and hyphens, 2-39
          characters. You'll be its first member; add the others afterwards.
        </p>
        <form onSubmit={(e) => void submit(e)} style={{ marginTop: 24 }}>
          <div className="field">
            <label htmlFor="org-slug">Slug</label>
            <div className="input-wrap">
              <input
                id="org-slug"
                required
                autoFocus
                autoCapitalize="none"
                spellCheck={false}
                aria-describedby="org-slug-status"
                value={slug}
                onChange={(e) => setSlug(e.target.value.trim().toLowerCase())}
              />
            </div>
            <p id="org-slug-status" className="hint muted" role="status">
              {problem ?? (available ? "Available" : "")}
            </p>
          </div>
          <div className="field">
            <label htmlFor="org-name">Display name (optional)</label>
            <div className="input-wrap">
              <input id="org-name" maxLength={100} value={name} onChange={(e) => setName(e.target.value)} />
            </div>
          </div>
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
          )}
          <button className="btn btn-md" type="submit" disabled={busy || !me || !slug || !!problem}>
            Create org
          </button>
        </form>
      </div>
    </Layout>
  );
}
