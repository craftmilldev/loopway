import { HARNESS_LABELS } from "@loopway/harnesses/labels";
import { STATE_COLORS } from "@loopway/palette";
import { Marked, type Tokens } from "marked";
import { useState, type ReactNode } from "react";
import { track } from "./metrics.js";

// The landing page, built from content/home.md: its comment says how the markdown maps to the page. Parsing turns
// the markdown into sections of blocks; the components below lay each section out by its id, and styles.css (the
// `lp-` rules) does the rest.

const md = new Marked();
const inline = (s: string) => md.parseInline(s, { async: false });

/** A list item: `**Title** — text`, with an indented italic line as its note. HTML, inline. */
export interface Item {
  /** The part of a `**Kicker · Title**` before the dot, set above the title. */
  kicker?: string;
  title?: string;
  text: string;
  note?: string;
  /** The automation level the item (or the list's caption) names, for its swatch. */
  level?: number;
}

export type Block =
  | { kind: "prose"; html: string; text: string }
  | { kind: "buttons"; links: { href: string; html: string; solid: boolean }[] }
  | { kind: "list"; ordered: boolean; start: number; caption?: string; level?: number; items: Item[] }
  | { kind: "well"; label: string; code: string };

export interface Section {
  id: string;
  /** The small typewritten line above the heading, as plain text. */
  label: string;
  /** The page's `#` headline, in the first section. */
  headline?: string;
  /** The section's `###` heading. */
  heading?: string;
  blocks: Block[];
}

/** The coding agents a bot can run on, as the page names them. */
export const AGENTS: readonly string[] = Object.values(HARNESS_LABELS);

/** "A, B, C or D". */
export function agentList(names: readonly string[]) {
  return names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} or ${names.at(-1)}`;
}

const levelOf = (text: string) => {
  const m = /\blevel (\d)\b/i.exec(text);
  return m ? Number(m[1]) : undefined;
};

function item(raw: string): Item {
  const lines = raw.split("\n");
  const last = lines.length > 1 ? /^([*_])(.+)\1$/.exec(lines.at(-1)!.trim()) : null;
  const main = (last ? lines.slice(0, -1) : lines).join("\n");
  const note = last ? inline(last[2]!) : undefined;
  const m = /^\*\*(.+?)\*\*\s+—\s+([\s\S]*)$/.exec(main);
  if (!m) return { text: inline(main), note };
  const dot = m[1]!.indexOf(" · ");
  const [kicker, title] = dot < 0 ? [undefined, m[1]!] : [m[1]!.slice(0, dot), m[1]!.slice(dot + 3)];
  return {
    kicker: kicker && inline(kicker),
    title: inline(title),
    text: inline(m[2]!),
    note,
    level: levelOf(kicker ?? title),
  };
}

/** A paragraph that is only links, one to a line: the section's buttons. */
const isButtons = (p: Tokens.Paragraph) =>
  p.tokens.some((t) => t.type === "link") &&
  p.tokens.every((t) => t.type === "link" || (t.type === "text" && t.raw.trim() === ""));

/** Splits home.md into its sections. `{agents}` becomes the agent list. */
export function parseHome(markdown: string, agents: readonly string[] = AGENTS): Section[] {
  const sections: Section[] = [];
  for (const t of md.lexer(markdown.replaceAll("{agents}", agentList(agents)))) {
    const heading = t.type === "heading" ? (t as Tokens.Heading) : undefined;
    if (heading?.depth === 2) {
      const m = /^(.*?)\s*\{#([\w-]+)\}$/.exec(heading.text);
      const label = m ? m[1]! : heading.text;
      sections.push({ id: m ? m[2]! : label.toLowerCase().replace(/\W+/g, "-"), label, blocks: [] });
      continue;
    }
    const s = sections.at(-1);
    // Anything before the first section (the comment at the top) isn't on the page.
    if (!s || t.type === "space" || t.type === "html") continue;
    const blocks = s.blocks;
    if (heading?.depth === 1) s.headline = inline(heading.text);
    else if (heading?.depth === 3) s.heading = inline(heading.text);
    else if (t.type === "code") {
      const code = t as Tokens.Code;
      blocks.push({ kind: "well", label: code.lang ?? "", code: code.text });
    } else if (t.type === "paragraph" && isButtons(t as Tokens.Paragraph)) {
      const solid = !blocks.some((b) => b.kind === "buttons");
      const links = (t as Tokens.Paragraph).tokens.filter((x): x is Tokens.Link => x.type === "link");
      blocks.push({
        kind: "buttons",
        links: links.map((l, i) => ({ href: l.href, html: inline(l.text), solid: solid && i === 0 })),
      });
    } else if (t.type === "list") {
      const list = t as Tokens.List;
      // A paragraph ending in a colon just before a list is the list's caption ("A level 4 loop:").
      const prev = blocks.at(-1);
      const caption = prev?.kind === "prose" && prev.text.endsWith(":") ? prev.text.slice(0, -1) : undefined;
      if (caption !== undefined) blocks.pop();
      blocks.push({
        kind: "list",
        ordered: list.ordered,
        start: typeof list.start === "number" ? list.start : 1,
        caption: caption && inline(caption),
        level: caption ? levelOf(caption) : undefined,
        items: list.items.map((i) => item(i.text)),
      });
    } else blocks.push({ kind: "prose", html: md.parser([t]), text: "text" in t ? String(t.text as unknown) : "" });
  }
  return sections;
}

/**
 * The figure for a section, by id: the terminal (top), a thread (threads) and the bots table (dashboard). Empty for
 * now; each figure fills its slot here.
 */
export const FIGURES: Record<string, () => ReactNode> = {
  top: () => null,
  threads: () => null,
  dashboard: () => null,
};

/** How each section lays out, by id. Any other id is "wide": the heading and its prose side by side, then the rest. */
const LAYOUTS: Record<string, "split" | "strip" | "wells" | "close" | "foot"> = {
  top: "split",
  listens: "strip",
  threads: "split",
  api: "wells",
  start: "close",
  colophon: "foot",
};

const Html = ({
  as: As = "div",
  className,
  html,
}: {
  as?: "div" | "span" | "h1" | "h2" | "h3" | "p";
  className?: string;
  html: string;
}) => <As className={className} dangerouslySetInnerHTML={{ __html: html }} />;

const Swatch = ({ level }: { level?: number }) =>
  level ? <span className={`lp-swatch lp-level-${level}`} aria-hidden="true" /> : null;

const linkTarget = (href: string) =>
  href.startsWith("#") ? "anchor" : href === "/login" ? "login" : href.includes("github.com") ? "github" : "other";

function Buttons({ section, links }: { section: string; links: Extract<Block, { kind: "buttons" }>["links"] }) {
  return (
    <div className="lp-buttons">
      {links.map((l) => (
        <a
          key={l.href + l.html}
          className={l.solid ? "btn" : "btn btn-quiet"}
          href={l.href}
          onClick={() =>
            track("landing_link_clicked", { section, kind: l.solid ? "solid" : "ghost", to: linkTarget(l.href) })
          }
          dangerouslySetInnerHTML={{ __html: l.html }}
        />
      ))}
    </div>
  );
}

function List({ section, list }: { section: string; list: Extract<Block, { kind: "list" }> }) {
  const Tag = list.ordered ? "ol" : "ul";
  return (
    <div className={list.ordered ? "lp-list lp-list-ordered" : "lp-list"}>
      {list.caption && (
        <div className="lp-caption">
          <Swatch level={list.level} />
          <span dangerouslySetInnerHTML={{ __html: list.caption }} />
        </div>
      )}
      <Tag className="lp-items" start={list.ordered && list.start !== 1 ? list.start : undefined}>
        {list.items.map((it, i) => (
          <li key={i} className={it.level ? `lp-at-${it.level}` : undefined}>
            {list.ordered && <span className="lp-num">{String(list.start + i).padStart(2, "0")}</span>}
            {it.kicker && (
              <div className="lp-kicker">
                <Swatch level={it.level} />
                <span dangerouslySetInnerHTML={{ __html: it.kicker }} />
              </div>
            )}
            {it.title && (
              <h3 className="lp-title">
                {!it.kicker && <Swatch level={it.level} />}
                {section === "dashboard" && it.title in STATE_COLORS ? (
                  <span className={`state state-${it.title}`} dangerouslySetInnerHTML={{ __html: it.title }} />
                ) : (
                  <span dangerouslySetInnerHTML={{ __html: it.title }} />
                )}
              </h3>
            )}
            <Html as="p" className="lp-text" html={it.text} />
            {it.note && <Html className="lp-note" html={it.note} />}
          </li>
        ))}
      </Tag>
    </div>
  );
}

function Well({ label, code }: { label: string; code: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
    } catch {
      return track("landing_well_copy_failed", { well: label || "none" });
    }
    track("landing_well_copied", { well: label || "none" });
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  return (
    <figure className="lp-well">
      {label && <figcaption className="lp-well-label">{label}</figcaption>}
      <button className="lp-well-copy" type="button" onClick={() => void copy()}>
        {copied ? "Copied" : "Copy"}
      </button>
      <pre>
        <code>
          {code.split("\n").map((line, i, all) => (
            // A line that doesn't start indented is a command, and gets a prompt; an indented one continues it, and a
            // blank one gets nothing.
            <span key={i} className={line === "" || /^\s/.test(line) ? undefined : "lp-cmd"}>
              {line}
              {i < all.length - 1 ? "\n" : ""}
            </span>
          ))}
        </code>
      </pre>
    </figure>
  );
}

function Blocks({ section, blocks }: { section: string; blocks: Block[] }) {
  return blocks.map((b, i) =>
    b.kind === "prose" ? (
      <Html key={i} className="lp-prose" html={b.html} />
    ) : b.kind === "buttons" ? (
      <Buttons key={i} section={section} links={b.links} />
    ) : b.kind === "list" ? (
      <List key={i} section={section} list={b} />
    ) : (
      <Well key={i} label={b.label} code={b.code} />
    ),
  );
}

const Figure = ({ id }: { id: string }) => {
  const figure = FIGURES[id];
  return figure ? (
    <div className="lp-figure" data-figure={id}>
      {figure()}
    </div>
  ) : null;
};

function SectionView({ s }: { s: Section }) {
  const layout = LAYOUTS[s.id] ?? "wide";
  const label = <div className="lp-label">{s.label}</div>;
  const heading = (
    <>
      {s.headline && <Html as="h1" className="lp-headline" html={s.headline} />}
      {s.heading && <Html as="h2" className="lp-heading" html={s.heading} />}
    </>
  );
  const blocks = (bs: Block[]) => <Blocks section={s.id} blocks={bs} />;
  let body: ReactNode;
  if (layout === "split")
    body = (
      <>
        <div className="lp-main">
          {label}
          {heading}
          {blocks(s.blocks)}
        </div>
        <Figure id={s.id} />
      </>
    );
  else if (layout === "wells")
    body = (
      <>
        <div className="lp-main">
          {label}
          {heading}
          {blocks(s.blocks.filter((b) => b.kind !== "well"))}
        </div>
        <div className="lp-side">{blocks(s.blocks.filter((b) => b.kind === "well"))}</div>
      </>
    );
  else if (layout === "close") {
    // Everything up to the first buttons is the call to action; whatever follows goes to the side.
    const cut = s.blocks.findIndex((b) => b.kind === "buttons") + 1 || s.blocks.length;
    body = (
      <>
        <div className="lp-main">
          {heading}
          {blocks(s.blocks.slice(0, cut))}
        </div>
        {cut < s.blocks.length && <div className="lp-side">{blocks(s.blocks.slice(cut))}</div>}
      </>
    );
  } else if (layout === "foot") body = blocks(s.blocks);
  else if (layout === "strip")
    body = (
      <>
        {label}
        {blocks(s.blocks)}
      </>
    );
  else {
    // The prose before the first list or well sits beside the heading.
    const cut = s.blocks.findIndex((b) => b.kind !== "prose");
    const intro = cut < 0 ? s.blocks : s.blocks.slice(0, cut);
    body = (
      <>
        <div className="lp-head">
          <div className="lp-head-main">
            {label}
            {heading}
          </div>
          {intro.length > 0 && <div className="lp-intro">{blocks(intro)}</div>}
        </div>
        <Figure id={s.id} />
        {cut >= 0 && blocks(s.blocks.slice(cut))}
      </>
    );
  }
  // The close and the colophon don't show their label; it names the section for screen readers instead.
  const hidden = layout === "close" || layout === "foot";
  return (
    <section id={s.id} className={`lp-section lp-${layout} lp-id-${s.id}`} aria-label={hidden ? s.label : undefined}>
      <div className="lp-in">{body}</div>
    </section>
  );
}

/** The page's sections, in the order home.md has them. */
export function LandingSections({ sections }: { sections: Section[] }) {
  return sections.map((s) => <SectionView key={s.id} s={s} />);
}
