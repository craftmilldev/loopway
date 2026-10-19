import { useEffect, useRef, useState } from "react";
import { HARNESS_LABELS } from "@loopway/harnesses/labels";
import { COMMANDS, CopyCommand } from "./runners.js";
import { DashLayout, MembersHint } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

/** The harnesses the setup bot can run on: every one that runs an agent. */
const SETUP_HARNESSES = Object.entries(HARNESS_LABELS).filter(([name]) => name !== "script");

/**
 * Asks which coding agent the user uses and makes the org's hidden setup bot on it. Picking another one later moves the
 * bot, so the choice isn't final.
 */
function HarnessPicker() {
  const [picked, setPicked] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const pick = async (harness: string) => {
    setSaving(true);
    setError(null);
    track("zero_state_harness_picked", { harness });
    try {
      const r = await lw.api("/setup-bot", { method: "PUT", body: { org: lw.orgSlug(), harness } });
      if (!r.ok) {
        track("zero_state_setup_bot_failed", { harness, reason: (await lw.errorCode(r)) ?? "http_" + r.status });
        return setError(await lw.message(r));
      }
      setPicked(harness);
    } catch {
      track("zero_state_setup_bot_failed", { harness, reason: "network" });
      setError("Couldn't reach loopway. Try again.");
    } finally {
      setSaving(false);
    }
  };
  return (
    <section aria-label="Pick your coding agent" style={{ marginTop: 24 }}>
      <h2>Which coding agent do you use?</h2>
      <p className="muted">Your setup assistant runs on it, on your runner.</p>
      <p style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
        {SETUP_HARNESSES.map(([name, label]) => (
          <button
            key={name}
            type="button"
            className={"btn btn-md" + (picked === name ? "" : " btn-quiet")}
            aria-pressed={picked === name}
            disabled={saving}
            onClick={() => void pick(name)}
          >
            {label}
          </button>
        ))}
      </p>
      {picked && (
        <p className="muted">
          Your setup assistant is ready on {HARNESS_LABELS[picked as keyof typeof HARNESS_LABELS]}.
        </p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}

/** What an org with no bots sees in place of its dashboard: get a runner going, then the bots come from there. */
export function ZeroState() {
  const me = lw.useMe();
  // A runner is connected while it holds its lease (the same "online" as the runners page), so one that registered once
  // and was closed doesn't count. Polled so the page moves on without a refresh; a failed poll leaves the install steps up.
  const runners = lw.useList<lw.Runner>(lw.inOrg("/runners"), true);
  lw.usePoll(runners.reload, true);
  const connected = !!runners.data?.some((r) => r.leased_until);
  useEffect(() => {
    track("zero_state_viewed");
  }, []);
  const seen = useRef(false);
  useEffect(() => {
    if (connected && !seen.current) {
      seen.current = true;
      track("zero_state_runner_connected");
    }
  }, [connected]);
  return (
    <DashLayout title="Get your runner going · loopway" me={me}>
      {connected ? (
        <>
          <div className="page-head">
            <h1>Your runner is connected</h1>
          </div>
          <HarnessPicker />
          <p className="muted" style={{ marginTop: 24 }}>
            Or make a bot for it to run yourself.
          </p>
          <p style={{ marginTop: 16 }}>
            <a
              className="btn btn-md"
              href={lw.orgBase() + "/bots/new"}
              onClick={() => track("zero_state_new_bot_clicked")}
            >
              New bot
            </a>
          </p>
        </>
      ) : (
        <>
          <div className="page-head">
            <h1>Get your runner going and we'll make some bots together</h1>
          </div>
          <section className="runner-setup" aria-label="Start a runner">
            <p className="muted">Run these on the machine where your code lives, and leave the last one open.</p>
            {COMMANDS.map((c) => (
              <CopyCommand key={c.key} command={c} from="zero_state" />
            ))}
          </section>
        </>
      )}
      <p className="muted" style={{ marginTop: 24 }}>
        <a href={lw.orgBase() + "/members"}>Members</a>
        <MembersHint />
      </p>
    </DashLayout>
  );
}
