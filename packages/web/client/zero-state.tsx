import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { HARNESS_LABELS } from "@loopway/harnesses/labels";
import { AgentPrompt } from "./agent-prompt.js";
import { COMMANDS, CopyCommand } from "./runners.js";
import { DashLayout, MembersHint, OrgsContext } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

/** The three steps of the zero state, each done once its condition holds. */
export interface SetupProgress {
  /** A runner is connected (or a bot has run, which needs one): it holds its lease (the same "online" as the runners page), so one that registered once and was closed doesn't count. */
  runner: boolean;
  /** The org has a bot. */
  bot: boolean;
  /** A bot has handled its first message. */
  ran: boolean;
}

export const setupDone = (p: SetupProgress) => p.runner && p.bot && p.ran;

/** The first step not done, 0 to 2. */
const currentStep = (p: SetupProgress) => (!p.runner ? 0 : !p.bot ? 1 : 2);

/**
 * How far the org's setup is. Polled, so the page moves on without a refresh, until all three steps are done. Null
 * until the first load settles; false if that load fails, so the pages show as usual. A failed poll after that keeps
 * what it had.
 */
export function useSetupProgress(enabled: boolean): SetupProgress | false | null {
  const [progress, setProgress] = useState<SetupProgress | false | null>(null);
  // The events already sent; an org whose first load finds the setup finished was never in the zero state and sends none.
  const sent = useRef({ runner: false, bot: false, ran: false, completed: false });
  const first = useRef(true);
  const load = useCallback(async () => {
    const get = async <T,>(path: string) => {
      const r = await lw.api(lw.inOrg(path)).catch(() => null);
      return r?.ok ? ((await r.json().catch(() => null)) as { data?: T[] } | null)?.data : undefined;
    };
    const [bots, runners, activity] = await Promise.all([
      get<unknown>("/bots"),
      get<lw.Runner>("/runners"),
      get<lw.BotActivity>("/bots/activity?days=1"),
    ]);
    const wasFirst = first.current;
    first.current = false;
    if (!bots || !runners || !activity) {
      if (wasFirst) setProgress(false);
      return false;
    }
    // A bot that has run proves a runner connected once, so an established org whose runner is closed isn't sent back.
    const ran = activity.some((a) => a.last_delivery_at);
    const next = { runner: ran || runners.some((r) => r.leased_until), bot: bots.length > 0, ran };
    const done = sent.current;
    if (wasFirst && setupDone(next)) Object.assign(done, { ...next, completed: true });
    for (const [step, event] of [
      ["runner", "zero_state_runner_connected"],
      ["bot", "zero_state_bot_created"],
      ["ran", "zero_state_first_run"],
    ] as const) {
      if (next[step] && !done[step]) {
        done[step] = true;
        track(event);
      }
    }
    if (setupDone(next) && !done.completed) {
      done.completed = true;
      track("zero_state_completed");
    }
    setProgress(next);
    return true;
  }, []);
  useEffect(() => {
    if (enabled) void load();
  }, [enabled, load]);
  lw.usePoll(load, enabled && progress !== false && !(progress && setupDone(progress)));
  return progress;
}

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

const STEPS = ["Get loopway running", "Make your first bot", "See it run"];

/** What an org that hasn't finished setting up sees in place of its dashboard: three steps, then the app. */
export function ZeroState({ progress }: { progress: SetupProgress }) {
  const me = lw.useMe();
  const chat = !!useContext(OrgsContext)?.find((o) => o.slug === lw.orgSlug())?.first_bot_by_chat;
  useEffect(() => {
    track("zero_state_viewed");
  }, []);
  const current = currentStep(progress);
  const done = [progress.runner, progress.bot, progress.ran];
  return (
    <DashLayout title="Get started · loopway" me={me}>
      <ol className="setup-steps" aria-label="Setup progress">
        {STEPS.map((label, i) => (
          <li key={label} className={done[i] ? "done" : undefined} aria-current={i === current ? "step" : undefined}>
            <span className="setup-circle" aria-label={done[i] ? "Done" : undefined}>
              {done[i] ? "✓" : i + 1}
            </span>
            {label}
          </li>
        ))}
      </ol>
      {current === 0 && (
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
      {current === 1 && (
        <>
          <div className="page-head">
            <h1>Your runner is connected</h1>
          </div>
          {chat && <HarnessPicker />}
          <AgentPrompt from="zero_state" />
        </>
      )}
      {current === 2 && (
        <>
          <div className="page-head">
            <h1>Your bot is ready</h1>
          </div>
          <p className="muted">
            Send it a message, with a webhook to its inbox. This page moves on when it has run for the first time.
          </p>
        </>
      )}
      <p className="muted" style={{ marginTop: 24 }}>
        <a href={lw.orgBase() + "/members"}>Members</a>
        <MembersHint />
      </p>
    </DashLayout>
  );
}
