import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { botState, type BotState } from "./bot-state.js";
import * as lw from "./lw.js";
import { track } from "./metrics.js";

/** With more bots than this the list gets a find box. */
export const FIND_AFTER = 8;

const Dot = ({ state }: { state: BotState | null }) =>
  state ? <span className={"dot state-" + state} title={state} /> : <span className="dot" aria-hidden="true" />;

const tabNow = () => new URLSearchParams(location.search).get("tab") ?? "activity";

/** One bot in the open list. Its threads are fetched when it mounts, which is when the list opens. */
function Item({
  bot,
  href,
  current,
  currentState,
  runners,
}: {
  bot: lw.Bot;
  href: string;
  current: boolean;
  currentState: BotState | null;
  runners: lw.Runner[] | null;
}) {
  const threads = lw.useList<lw.Thread>("/bots/" + encodeURIComponent(bot.id) + "/threads?status=active", !current);
  const state = current ? currentState : threads.data && runners ? botState(threads.data, runners) : null;
  return (
    <a
      role="menuitem"
      href={href}
      aria-current={current ? "page" : undefined}
      onClick={() => track("bot_switched", { tab: tabNow() })}
    >
      <Dot state={state} />
      {bot.name}
    </a>
  );
}

/**
 * The bot page's bot switcher: the current bot's name and mark, and a list of every bot to switch to, on the same
 * tab. The other bots' marks are fetched only while the list is open.
 */
export function BotSwitcher({
  bots,
  current,
  currentState,
  runners,
  pathFor,
}: {
  bots: lw.Bot[];
  current: string;
  currentState: BotState | null;
  runners: lw.Runner[] | null;
  pathFor: (botId: string) => string;
}) {
  const [open, setOpen] = useState(false);
  const [find, setFind] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const finder = bots.length > FIND_AFTER;
  const needle = find.trim().toLowerCase();
  const shown = needle ? bots.filter((b) => b.name.toLowerCase().includes(needle)) : bots;
  const name = bots.find((b) => b.id === current)?.name ?? "Bot";

  function close(refocus: boolean) {
    setOpen(false);
    setFind("");
    if (refocus) button.current?.focus();
  }

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) close(false);
    };
    document.addEventListener("mousedown", away);
    return () => document.removeEventListener("mousedown", away);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const m = menu.current;
    (finder
      ? m?.querySelector<HTMLElement>("input")
      : (m?.querySelector<HTMLElement>('[aria-current="page"]') ?? m?.querySelector<HTMLElement>("a"))
    )?.focus();
  }, [open, finder]);

  useEffect(() => {
    if (open && needle && shown.length === 0) track("bot_switcher_find_empty");
  }, [open, needle, shown.length]);

  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      return close(true);
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    if (finder && (e.key === "Home" || e.key === "End") && document.activeElement?.tagName === "INPUT") return;
    const stops = Array.from(menu.current?.querySelectorAll<HTMLElement>("input, a") ?? []);
    if (!stops.length) return;
    e.preventDefault();
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? stops.length - 1 : e.key === "ArrowDown" ? at + 1 : at - 1;
    stops[(next + stops.length) % stops.length]?.focus();
  }

  function toggle() {
    if (open) return close(false);
    track("bot_switcher_opened", { bots: bots.length > 30 ? "30+" : bots.length > FIND_AFTER ? "9-30" : "1-8" });
    setOpen(true);
  }

  return (
    <div className="bot-switch" ref={root} onKeyDown={open ? keys : undefined}>
      <button
        type="button"
        ref={button}
        className="bot-switch-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Bot: ${name}. Switch bot`}
        onClick={toggle}
      >
        <Dot state={currentState} />
        <span className="bot-switch-name">{name}</span>
        <span className="bot-switch-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="bot-switch-list" role="menu" aria-label="Bots" ref={menu}>
          {finder && (
            <input
              type="search"
              className="bot-switch-find"
              placeholder="Find a bot"
              aria-label="Find a bot"
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
          )}
          <div className="bot-switch-items">
            <a role="menuitem" href="/dashboard/bots" onClick={() => track("bot_switcher_all_bots")}>
              All bots
            </a>
            {shown.map((b) => (
              <Item
                key={b.id}
                bot={b}
                href={pathFor(b.id)}
                current={b.id === current}
                currentState={currentState}
                runners={runners}
              />
            ))}
            {needle && shown.length === 0 && <p className="muted bot-switch-empty">No bot matches.</p>}
          </div>
        </div>
      )}
    </div>
  );
}
