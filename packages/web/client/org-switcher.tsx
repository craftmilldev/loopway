import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { Org } from "./lw.js";
import { track } from "./metrics.js";

/**
 * The header's org switcher: the current org's slug, and a list of the user's orgs (personal one first, labeled as
 * theirs). Choosing one goes to that org's overview.
 */
export function OrgSwitcher({ orgs, current }: { orgs: Org[]; current: string }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  function close(refocus: boolean) {
    setOpen(false);
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
    (m?.querySelector<HTMLElement>('[aria-current="page"]') ?? m?.querySelector<HTMLElement>("a"))?.focus();
  }, [open]);

  function keys(e: KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      return close(true);
    }
    if (e.key === "Tab") return close(false);
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    const stops = Array.from(menu.current?.querySelectorAll<HTMLElement>("a") ?? []);
    if (!stops.length) return;
    e.preventDefault();
    const at = stops.indexOf(document.activeElement as HTMLElement);
    const next = e.key === "Home" ? 0 : e.key === "End" ? stops.length - 1 : e.key === "ArrowDown" ? at + 1 : at - 1;
    stops[(next + stops.length) % stops.length]?.focus();
  }

  function toggle() {
    if (open) return close(false);
    track("org_switcher_opened", { orgs: orgs.length > 5 ? "6+" : orgs.length });
    setOpen(true);
  }

  return (
    <div className="bot-switch org-switch" ref={root} onKeyDown={open ? keys : undefined}>
      <button
        type="button"
        ref={button}
        className="bot-switch-button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`Org: ${current}. Switch org`}
        onClick={toggle}
      >
        <span className="bot-switch-name">{current}</span>
        <span className="bot-switch-caret" aria-hidden="true">
          ▾
        </span>
      </button>
      {open && (
        <div className="bot-switch-list" ref={menu}>
          <div className="bot-switch-items" role="menu" aria-label="Orgs">
            {orgs.map((o) => (
              <a
                key={o.id}
                role="menuitem"
                href={"/" + encodeURIComponent(o.slug)}
                aria-current={o.slug === current ? "page" : undefined}
                onClick={(e) => {
                  if (o.slug === current) e.preventDefault();
                  track("org_switched", { to_personal: o.personal, same: o.slug === current });
                }}
              >
                {o.slug}
                {o.personal ? " (you)" : ""}
              </a>
            ))}
            <a role="menuitem" href="/orgs/new" onClick={() => track("org_new_clicked")}>
              + New org
            </a>
          </div>
        </div>
      )}
    </div>
  );
}
