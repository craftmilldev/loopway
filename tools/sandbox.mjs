#!/usr/bin/env node
// Opens, lists and closes the issues a live verification makes in the sandbox repo, and only there:
//   npm run sandbox -- open <pr> "<title>" [--body <text>]   opens "[#<pr>] <title>"
//   npm run sandbox -- list <pr>                             the issues and PRs with [#<pr>] in the title
//   npm run sandbox -- close <pr>                            closes every open one, and deletes their branches
// Plain Node, no dependencies. `GH` names the gh binary (the test fakes it). See AGENTS.md.
import { execFileSync } from "node:child_process";

const SANDBOX = "craftmilldev/loopway-sandbox";
const GH = process.env.GH || "gh";

const gh = (...args) => execFileSync(GH, args, { encoding: "utf8" }).trim();
const json = (...args) => JSON.parse(gh(...args) || "[]");
const tag = (pr) => `[#${pr}]`;

/** Everything in the sandbox whose title carries this PR's tag, issues and pull requests alike. The sandbox is shared, so nothing else is ever touched. */
function mine(pr, state) {
  const found = (kind, fields) =>
    json(
      kind,
      "list",
      "-R",
      SANDBOX,
      "--state",
      state,
      "--search",
      `"${tag(pr)}" in:title`,
      "--json",
      fields,
      "-L",
      "100",
    ).filter((item) => item.title.includes(tag(pr)));
  return [
    ...found("issue", "number,title,state").map((i) => ({ ...i, kind: "issue" })),
    ...found("pr", "number,title,state,headRefName").map((p) => ({ ...p, kind: "pr" })),
  ];
}

function main() {
  const [command, pr, title, ...rest] = process.argv.slice(2);
  if (!/^\d+$/.test(pr ?? ""))
    throw new Error("usage: sandbox open <pr> <title> [--body <text>] | list <pr> | close <pr>");
  if (command === "open") {
    if (!title) throw new Error("open needs a title");
    const body = rest[0] === "--body" ? (rest[1] ?? "") : "";
    console.log(
      gh(
        "issue",
        "create",
        "-R",
        SANDBOX,
        "--title",
        `${tag(pr)} ${title}`,
        "--body",
        body || `Opened by the verification of #${pr}.`,
      ),
    );
  } else if (command === "list") {
    for (const item of mine(pr, "all"))
      console.log(`${item.kind} #${item.number} ${item.state.toLowerCase()} ${item.title}`);
  } else if (command === "close") {
    for (const item of mine(pr, "open")) {
      gh(item.kind, "close", String(item.number), "-R", SANDBOX);
      if (item.kind === "pr") gh("api", "-X", "DELETE", `repos/${SANDBOX}/git/refs/heads/${item.headRefName}`);
      console.log(`closed ${item.kind} #${item.number} ${item.title}`);
    }
  } else throw new Error(`unknown command ${command}`);
}

try {
  main();
} catch (err) {
  console.error(`sandbox: ${err.message}`);
  process.exit(1);
}
