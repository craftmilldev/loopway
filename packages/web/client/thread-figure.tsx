// The threads section's figure on the landing page: a sample thread in which a bot asks a person a question and the
// person answers where they already work. All of it is sample data; none of the names are real bots.

const BOT = "deploy-medic";

interface Sample {
  text: string;
  type: string;
  time: string;
}

const ANSWER: Sample = {
  text: "ada commented on #241: “Yes, roll back and leave the fix to issue-to-pr.”",
  type: "com.github.issue_comment.created",
  time: "14:20",
};

const ERROR: Sample = {
  text: "The production deploy of shop failed at build",
  type: "com.vercel.deployment.error",
  time: "13:11",
};

const QUESTION = "The build fails on a type error from b9e20e2. Roll back to eb83c73 and leave the fix to issue-to-pr?";

const Event = ({ e }: { e: Sample }) => (
  <div className="lp-event">
    <div className="lp-event-main">
      <div className="lp-event-text">{e.text}</div>
      <div className="lp-event-type">{e.type}</div>
    </div>
    <div className="lp-event-time">{e.time}</div>
  </div>
);

export function ThreadFigure() {
  return (
    <figure className="lp-thread">
      <div className="lp-thread-head">
        <div className="lp-thread-label">{BOT} · thread</div>
        <div className="lp-thread-title">Production deploy failed at build</div>
        <div className="lp-thread-tags">
          <span>vercel dpl_9xK2</span>
          <span>acme/shop#241</span>
          <span>
            <span className="lp-swatch lp-level-3" aria-hidden="true" />
            level 3
          </span>
        </div>
      </div>
      <div className="lp-thread-body">
        <div className="lp-thread-group">Waiting · 1</div>
        <Event e={ANSWER} />
        <div className="lp-thread-group">Run 1 · delivered 13:12</div>
        <Event e={ERROR} />
        <div className="lp-thread-ask">
          <div className="lp-thread-label">{BOT}, on #241</div>
          {QUESTION}
        </div>
        <div className="lp-thread-log">
          <span className="lp-cmd">tail -f ~/.loopway/threads/thr_8f2c.log</span>
        </div>
      </div>
    </figure>
  );
}
