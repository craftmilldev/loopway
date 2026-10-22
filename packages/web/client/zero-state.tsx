import { useCallback, useEffect, useRef, useState } from "react";
import { AgentPrompt } from "./agent-prompt.js";
import { commands, CopyCommand } from "./runners.js";
import { DashLayout, MembersHint } from "./layout.js";
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

const STEPS = ["Get loopway running", "Make your first bot", "See it run"];

/** The three step circles: done ones filled, the first one not done highlighted. */
function SetupSteps({ progress }: { progress: SetupProgress }) {
  const current = currentStep(progress);
  const done = [progress.runner, progress.bot, progress.ran];
  return (
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
  );
}

/**
 * Shown once per org when its three steps are done, in place of the app: every step filled, what the user just did,
 * and a button on to the app. `onContinue` is called once the org has been marked as having seen it.
 */
export function Celebration({ slug, onContinue }: { slug: string; onContinue: () => void }) {
  const me = lw.useMe();
  const [busy, setBusy] = useState(false);
  const proceed = async () => {
    setBusy(true);
    // If this fails the app still opens; the celebration comes back on the next visit.
    await lw.api("/orgs/" + encodeURIComponent(slug) + "/celebrated", { method: "POST" }).catch(() => null);
    onContinue();
  };
  return (
    <DashLayout title="You did it · loopway" me={me}>
      <SetupSteps progress={{ runner: true, bot: true, ran: true }} />
      <section className="celebration" aria-label="Setup complete">
        <p className="celebration-mark" aria-hidden="true">
          ✓
        </p>
        <h1>You did it</h1>
        <p className="muted">
          You connected a runner, made your first bot and watched it handle its first message. loopway is working for
          you now.
        </p>
        <button className="btn btn-md" type="button" disabled={busy} onClick={() => void proceed()}>
          Continue to loopway
        </button>
      </section>
    </DashLayout>
  );
}

/** What an org that hasn't finished setting up sees in place of its dashboard: three steps, then the app. */
export function ZeroState({ progress }: { progress: SetupProgress }) {
  const me = lw.useMe();
  useEffect(() => {
    track("zero_state_viewed");
  }, []);
  const current = currentStep(progress);
  return (
    <DashLayout title="Get started · loopway" me={me}>
      <SetupSteps progress={progress} />
      {current === 0 && (
        <>
          <div className="page-head">
            <h1>Get your runner going and we'll make some bots together</h1>
          </div>
          <section className="runner-setup" aria-label="Start a runner">
            <p className="muted">Run these on the machine where your code lives, and leave the last one open.</p>
            {commands(lw.orgSlug()).map((c) => (
              <CopyCommand key={c.key} command={c} from="zero_state" />
            ))}
          </section>
          <AgentPrompt from="zero_state" />
        </>
      )}
      {current === 1 && (
        <>
          <div className="page-head">
            <h1>Your runner is connected</h1>
          </div>
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
        <MembersHint />
      </p>
    </DashLayout>
  );
}
