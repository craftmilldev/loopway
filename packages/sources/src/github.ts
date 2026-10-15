import { createHmac } from "node:crypto";
import { z } from "zod";
import { firstLine, get, str, withText, type Payload } from "./payload.js";
import type { CloudEvent, SourceAdapter, SourceDeps } from "./types.js";

/**
 * GitHub webhooks → CloudEvents, following the CloudEvents GitHub adapter spec:
 * https://github.com/cloudevents/spec/blob/main/cloudevents/adapters/github.md
 *
 *   id      = X-GitHub-Delivery
 *   type    = com.github.<event>[.<action>]
 *   source  = repository.url (varies per event, see RULES)
 *   subject = per event (see RULES)
 *   time    = per event, falling back to receive time
 *   data    = the webhook payload
 */

export interface GithubConfig {
  /** Shared secret entered in GitHub's webhook "Secret" field. Used to verify X-Hub-Signature-256. */
  secret: string;
  /** GitHub event names to accept (e.g. ["push", "pull_request"]). ["*"] accepts everything. */
  events: string[];
}

const MIN_SECRET = 16;

const configInput = z
  .object({
    secret: z.string().min(MIN_SECRET, `secret must be at least ${MIN_SECRET} characters`).optional(),
    events: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

interface Rule {
  /** Dotted path, or a function, for `source`. Default: repository.url → organization.url → sender.url. */
  source?: string | ((p: Payload) => unknown);
  /** Dotted path for `subject`. Omitted when absent. */
  subject?: string;
  /** Dotted paths tried in order for `time`. Default: receive time. */
  time?: string[];
  /** Replaces the default `.<action>` type suffix. Return "" for no suffix. */
  suffix?: (p: Payload) => unknown;
}

const noSuffix = () => "";
const at = (path: string) => (p: Payload) => get(p, path);

const RULES: Record<string, Rule> = {
  branch_protection_rule: { subject: "rule.id", time: ["rule.updated_at"] },
  check_run: { subject: "check_run.id", time: ["check_run.completed_at", "check_run.started_at"] },
  check_suite: { subject: "check_suite.id", time: ["check_suite.updated_at"] },
  code_scanning_alert: { subject: "alert.number" },
  commit_comment: {
    source: (p) => {
      const url = str(get(p, "comment.url"));
      const sha = str(get(p, "comment.commit_id"));
      return url && sha ? `${url}/${sha}` : undefined;
    },
    subject: "comment.id",
    time: ["comment.updated_at"],
  },
  create: { subject: "ref", suffix: at("ref_type") },
  delete: { subject: "ref", suffix: at("ref_type") },
  dependabot_alert: { subject: "alert.id" },
  deploy_key: { subject: "key.id", time: ["key.deleted_at", "key.created_at"] },
  deployment: { subject: "deployment.id", time: ["deployment.updated_at"], suffix: noSuffix },
  deployment_status: {
    source: "deployment.url",
    subject: "deployment_status.url",
    time: ["deployment_status.updated_at"],
    suffix: at("deployment_status.state"),
  },
  discussion: { subject: "discussion.id" },
  discussion_comment: { subject: "discussion.id", time: ["comment.updated_at"] },
  fork: { subject: "forkee.url", time: ["forkee.created_at"], suffix: noSuffix },
  gollum: { suffix: noSuffix },
  installation: {
    source: "installation.account.url",
    subject: "installation.id",
    time: ["installation.updated_at"],
  },
  installation_repositories: {
    source: "installation.account.url",
    subject: "installation.id",
    time: ["installation.updated_at"],
  },
  issue_comment: { source: "issue.url", subject: "comment.id", time: ["comment.updated_at"] },
  issues: { subject: "issue.number", time: ["issue.updated_at"] },
  label: { subject: "label.name" },
  member: { subject: "member.login" },
  membership: {
    source: "team.url",
    subject: "member.login",
    suffix: (p) => [get(p, "scope"), get(p, "action")].filter(Boolean).join("."),
  },
  merge_group: { subject: "merge_group.head_ref" },
  meta: { subject: "hook_id", time: ["hook.updated_at"] },
  milestone: { subject: "milestone.number", time: ["milestone.updated_at"] },
  organization: { source: "organization.url", subject: "membership.user.login" },
  package: { subject: "package.id", time: ["package.updated_at", "package.created_at"] },
  public: {
    source: "repository.owner.url",
    subject: "repository.name",
    time: ["repository.updated_at"],
    suffix: noSuffix,
  },
  pull_request: { subject: "number", time: ["pull_request.updated_at"] },
  pull_request_review: { source: "pull_request.url", subject: "review.id", time: ["review.submitted_at"] },
  pull_request_review_comment: {
    source: "pull_request.url",
    subject: "comment.id",
    time: ["pull_request.updated_at"],
  },
  pull_request_review_thread: { source: "pull_request.url", subject: "pull_request.id" },
  push: { subject: "ref", suffix: noSuffix },
  release: {
    subject: "release.id",
    time: ["release.published_at", "release.updated_at", "release.created_at"],
  },
  repository: { source: "repository.owner.url", subject: "repository.name", time: ["repository.updated_at"] },
  repository_dispatch: { source: "repository.owner.url" },
  secret_scanning_alert: { subject: "alert.number", time: ["alert.updated_at", "alert.created_at"] },
  star: { time: ["starred_at"] },
  status: { subject: "sha", time: ["updated_at"], suffix: at("state") },
  workflow_dispatch: { subject: "workflow", suffix: noSuffix },
  workflow_job: { subject: "workflow_job.name" },
  workflow_run: { subject: "workflow.name" },
};

export const github = ({ newSecret, safeEqual, makeCloudEvent }: SourceDeps): SourceAdapter<GithubConfig> => ({
  type: "github",
  label: "GitHub",
  description: "GitHub repository/org/app webhooks, verified with X-Hub-Signature-256.",
  events: [
    "push",
    "pull_request",
    "pull_request_review",
    "pull_request_review_comment",
    "issues",
    "issue_comment",
    "release",
    "workflow_run",
    "workflow_job",
    "check_run",
    "check_suite",
    "create",
    "delete",
    "deployment_status",
    "discussion",
    "star",
    "fork",
  ],
  secret: { from: "loopway", minLength: MIN_SECRET },
  webhookSettings: "GitHub → Settings → Webhooks",

  parseConfig(input, existing) {
    const parsed = configInput.parse(input ?? {});
    return {
      secret: parsed.secret ?? existing?.secret ?? newSecret(),
      events: parsed.events ?? existing?.events ?? ["*"],
    };
  },

  publicConfig(config) {
    return { secret: config.secret, events: config.events };
  },

  setup(config, webhookUrl) {
    return {
      payload_url: webhookUrl,
      content_type: "application/json (application/x-www-form-urlencoded also works)",
      secret: config.secret,
      events: config.events.includes("*") ? "Send me everything" : config.events,
    };
  },

  summarize: githubSummary,
  title: githubTitle,
  authorKind: githubAuthorKind,

  receive({ headers, rawBody, receivedAt }, config) {
    const event = headers.get("x-github-event");
    if (!event) return { kind: "rejected", status: 400, message: "Missing X-GitHub-Event header" };

    const signature = headers.get("x-hub-signature-256");
    if (!signature) return { kind: "rejected", status: 401, message: "Missing X-Hub-Signature-256 header" };
    const expected = "sha256=" + createHmac("sha256", config.secret).update(rawBody, "utf8").digest("hex");
    if (!safeEqual(signature, expected)) return { kind: "rejected", status: 401, message: "Signature mismatch" };

    if (event === "ping") return { kind: "ignored", reason: "ping" };
    if (!config.events.includes("*") && !config.events.includes(event)) {
      return { kind: "rejected", status: 422, message: `event "${event}" not enabled for this inbox` };
    }

    const delivery = headers.get("x-github-delivery");
    if (!delivery) return { kind: "rejected", status: 400, message: "Missing X-GitHub-Delivery header" };

    let payload: Payload;
    try {
      payload = parseBody(headers.get("content-type") ?? "", rawBody);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Invalid body";
      return { kind: "rejected", status: message.startsWith("Unsupported") ? 415 : 400, message };
    }

    const rule = RULES[event] ?? {};
    const suffix = str(rule.suffix ? rule.suffix(payload) : payload.action);
    const source =
      str(typeof rule.source === "function" ? rule.source(payload) : rule.source && get(payload, rule.source)) ??
      str(get(payload, "repository.url")) ??
      str(get(payload, "organization.url")) ??
      str(get(payload, "sender.url")) ??
      "https://github.com";
    const time = (rule.time ?? []).map((p) => toIso(get(payload, p))).find(Boolean) ?? receivedAt.toISOString();

    return {
      kind: "event",
      event: makeCloudEvent({
        specversion: "1.0",
        id: delivery,
        source,
        type: `com.github.${event}${suffix ? `.${suffix}` : ""}`,
        subject: rule.subject ? str(get(payload, rule.subject)) : undefined,
        time,
        datacontenttype: "application/json",
        data: payload,
      }),
    };
  },
});

function parseBody(contentType: string, raw: string): Payload {
  const ct = contentType.split(";")[0]!.trim().toLowerCase();
  let json: string;
  if (ct === "application/json" || ct === "") json = raw;
  else if (ct === "application/x-www-form-urlencoded") {
    const p = new URLSearchParams(raw).get("payload");
    if (p == null) throw new Error("Form body is missing the `payload` field");
    json = p;
  } else throw new Error(`Unsupported content type: ${ct}`);
  const value: unknown = JSON.parse(json);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Payload must be a JSON object");
  return value as Payload;
}

/** GitHub mixes ISO strings and unix-seconds integers. */
function toIso(v: unknown): string | undefined {
  if (typeof v === "number") return new Date(v * 1000).toISOString();
  if (typeof v === "string" && v) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
  }
  return undefined;
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** The title of the issue or pull request an event carries, if it carries one. */
function githubTitle(event: CloudEvent): string | null {
  const p = event.data as Payload | undefined;
  return firstLine(str(get(p, "issue.title")) ?? str(get(p, "pull_request.title"))) ?? null;
}

/** Ends the body of what the review bot posts, though it posts as the user who runs it. */
const REVIEW_BOT_MARKER = "<!-- loopway-review -->";

/** A bot is a GitHub bot account (the sender's type, or a login ending in [bot]) or the review bot's comment. */
function githubAuthorKind(event: CloudEvent): "human" | "bot" | null {
  const p = (event.data ?? {}) as Payload;
  const login = str(get(p, "sender.login"));
  if (!login) return null;
  const body = str(get(p, "comment.body")) ?? str(get(p, "review.body"));
  if (body?.trimEnd().endsWith(REVIEW_BOT_MARKER)) return "bot";
  return get(p, "sender.type") === "Bot" || login.endsWith("[bot]") ? "bot" : "human";
}

/** One line on who did what, from the event type (com.github.<event>[.<action>]) and its payload. */
function githubSummary(event: CloudEvent): string | null {
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
