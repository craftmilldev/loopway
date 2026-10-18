import { useEffect, useRef } from "react";
import { COMMANDS, CopyCommand } from "./runners.js";
import { DashLayout, MembersHint } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

/** What an org with no bots sees in place of its dashboard: get a runner going, then the bots come from there. */
export function ZeroState() {
  const me = lw.useMe();
  // The runner registers itself on startup, so the org's first runner showing up means it is connected. Polled so the
  // page moves on without a refresh; a failed poll leaves the install steps up.
  const runners = lw.useList<lw.Runner>(lw.inOrg("/runners"), true);
  lw.usePoll(runners.reload, true);
  const connected = (runners.data?.length ?? 0) > 0;
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
          <p className="muted">Next, make a bot for it to run.</p>
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
