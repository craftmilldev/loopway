import { get, str, type Payload } from "./payload.js";
import type { CloudEvent } from "./types.js";

const MAX = 80;

/** First non-empty line of `text`, whitespace collapsed and cut to a line's length. */
function firstLine(text: string | undefined): string | undefined {
  const line = text
    ?.split(/\r?\n/)
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find(Boolean);
  if (!line) return undefined;
  return line.length > MAX ? line.slice(0, MAX - 1).trimEnd() + "…" : line;
}

const withText = (head: string, text: string | undefined) => {
  const line = firstLine(text);
  return line ? `${head}: ${line}` : head;
};

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The title of the issue or pull request an event carries, if it carries one. */
export function githubTitle(event: CloudEvent): string | null {
  const p = event.data as Payload | undefined;
  return firstLine(str(get(p, "issue.title")) ?? str(get(p, "pull_request.title"))) ?? null;
}

/** One line on who did what, from the event type (com.github.<event>[.<action>]) and its payload. */
export function githubSummary(event: CloudEvent): string | null {
  const p = (event.data ?? {}) as Payload;
  const [kind = "", action = str(p.action) ?? ""] = event.type.replace(/^com\.github\./, "").split(".");
  const actor = str(get(p, "sender.login"));
  if (!actor) return null;
  const n = str(get(p, "issue.number")) ?? str(get(p, "pull_request.number")) ?? str(p.number);
  const ref = n ? `#${n}` : "an issue";
  const branch = str(p.ref)?.replace(/^refs\/(heads|tags)\//, "");
  const repo = str(get(p, "repository.full_name"));
  const comment = `${action === "created" ? "commented" : action + " a comment"} on ${ref}`;

  switch (kind) {
    case "issues":
      return withText(`${actor} ${action} issue ${ref}`, str(get(p, "issue.title")));
    case "pull_request": {
      const verb = action === "closed" && get(p, "pull_request.merged") === true ? "merged" : action;
      return withText(`${actor} ${verb} pull request ${ref}`, str(get(p, "pull_request.title")));
    }
    case "issue_comment":
    case "pull_request_review_comment":
      return withText(`${actor} ${comment}`, str(get(p, "comment.body")));
    case "pull_request_review": {
      const state = str(get(p, "review.state"))?.toLowerCase();
      const verb =
        state === "approved" ? "approved" : state === "changes_requested" ? "requested changes on" : "reviewed";
      return withText(`${actor} ${verb} ${ref}`, str(get(p, "review.body")));
    }
    case "push": {
      const commits = Array.isArray(p.commits) ? p.commits.length : 0;
      return `${actor} pushed ${commits ? plural(commits, "commit") + " " : ""}to ${branch ?? repo ?? "a branch"}`;
    }
    case "release":
      return withText(`${actor} ${action} release`, str(get(p, "release.name")) ?? str(get(p, "release.tag_name")));
    case "workflow_run":
      return withText(`${actor} ${action} workflow run`, str(get(p, "workflow_run.name")));
    case "workflow_job":
      return withText(`${actor} ${action} workflow job`, str(get(p, "workflow_job.name")));
    case "check_run":
      return withText(`${actor} ${action} check run`, str(get(p, "check_run.name")));
    case "check_suite":
      return `${actor} ${action} check suite`;
    case "create":
    case "delete":
      return `${actor} ${kind === "create" ? "created" : "deleted"} ${str(p.ref_type) ?? "ref"} ${branch ?? ""}`.trim();
    case "deployment_status":
      return `${actor} deployment ${action}`;
    case "discussion":
      return withText(`${actor} ${action} discussion`, str(get(p, "discussion.title")));
    case "star":
      return `${actor} ${action === "deleted" ? "unstarred" : "starred"} ${repo ?? "the repository"}`;
    case "fork":
      return `${actor} forked ${repo ?? "the repository"}`;
    default:
      return `${actor} ${kind}${action ? " " + action : ""}`;
  }
}
