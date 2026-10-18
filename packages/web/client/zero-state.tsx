import { useEffect } from "react";
import { COMMANDS, CopyCommand } from "./runners.js";
import { DashLayout, MembersHint } from "./layout.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

/** What an org with no bots sees in place of its dashboard: get a runner going, then the bots come from there. */
export function ZeroState() {
  const me = lw.useMe();
  useEffect(() => {
    track("zero_state_viewed");
  }, []);
  return (
    <DashLayout title="Get your runner going · loopway" me={me}>
      <div className="page-head">
        <h1>Get your runner going and we'll make some bots together</h1>
      </div>
      <section className="runner-setup" aria-label="Start a runner">
        <p className="muted">Run these on the machine where your code lives, and leave the last one open.</p>
        {COMMANDS.map((c) => (
          <CopyCommand key={c.key} command={c} from="zero_state" />
        ))}
      </section>
      <p className="muted" style={{ marginTop: 24 }}>
        <a href={lw.orgBase() + "/members"}>Members</a>
        <MembersHint />
      </p>
    </DashLayout>
  );
}
