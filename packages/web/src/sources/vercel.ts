import { createHmac } from "node:crypto";
import { z } from "zod";
import { makeCloudEvent } from "../cloudevents.js";
import { safeEqual } from "../ids.js";
import { get, str, type Payload } from "./payload.js";
import type { SourceAdapter } from "./types.js";

/**
 * Vercel webhooks → CloudEvents. Vercel sends `{id, type, createdAt, region, payload}`:
 * https://vercel.com/docs/webhooks/webhooks-api
 *
 *   id      = body.id
 *   type    = com.vercel.<body.type> (e.g. com.vercel.deployment.error)
 *   source  = API URL of the project the event belongs to, else its team (like GitHub's repository.url)
 *   subject = the thing the event is about: the deployment id for deployment events, else per type
 *             (see SUBJECTS), falling back to body.id so every event has one
 *   time    = body.createdAt, falling back to receive time
 *   data    = the whole webhook body
 */

export interface VercelConfig {
  /** Signing secret Vercel shows once when the webhook is created. Unset until pasted in; deliveries get 401 until then. */
  secret?: string;
  /** Vercel event types to accept (e.g. ["deployment.error"]). ["*"] accepts everything. */
  events: string[];
}

const configInput = z
  .object({
    secret: z.string().min(1).optional(),
    events: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

/** Payload paths tried in order for `subject`, by event type prefix. First matching prefix wins. */
const SUBJECTS: [prefix: string, paths: string[]][] = [
  ["deployment.rollback", ["toDeploymentId"]],
  ["deployment.", ["deployment.id"]],
  ["project.domain.updated", ["next.domain", "previous.domain"]],
  ["project.domain.", ["domain.name"]],
  ["project.env-variable.", ["envVarId"]],
  ["project.rolling-release.", ["rollingRelease.default.targetDeploymentId"]],
  ["project.", ["project.id"]],
  ["domain.certificate-", ["cert.id", "dnsNames.0"]],
  ["domain.dns-records-changed", ["zone"]],
  ["domain.", ["domain.name"]],
  ["integration-configuration.", ["configuration.id"]],
  ["integration-resource.", ["resourceId"]],
  ["marketplace.invoice.", ["invoiceId"]],
  ["marketplace.member.", ["memberId"]],
  ["alerts.", ["groupId"]],
  ["flag.segment.", ["segment.id"]],
  ["flag.", ["flag.id"]],
  ["", ["deployment.id", "project.id", "projectId"]],
];

const PROJECT_PATHS = [
  "project.id",
  "projectId",
  "flag.projectId",
  "segment.projectId",
  "rollingRelease.projectId",
  "to.projectId",
];
const TEAM_PATHS = ["team.id", "teamId", "newTeamId"];

const API = "https://api.vercel.com";

export const vercel: SourceAdapter<VercelConfig> = {
  type: "vercel",
  description: "Vercel account/integration webhooks, verified with X-Vercel-Signature.",

  parseConfig(input, existing) {
    const parsed = configInput.parse(input ?? {});
    const secret = parsed.secret ?? existing?.secret;
    return { ...(secret ? { secret } : {}), events: parsed.events ?? existing?.events ?? ["*"] };
  },

  publicConfig(config) {
    return { secret: config.secret ?? null, events: config.events };
  },

  setup(config, webhookUrl) {
    return {
      endpoint_url: webhookUrl,
      events: config.events.includes("*") ? "Any (pick them in Vercel)" : config.events,
      secret: config.secret
        ? "set"
        : "not set yet: paste the secret Vercel shows after you create the webhook with `loopway inbox update <inbox> --secret`",
    };
  },

  receive({ headers, rawBody, receivedAt }, config) {
    if (!config.secret) {
      return { kind: "rejected", status: 401, message: "No secret set for this inbox yet; add the one Vercel shows" };
    }
    const signature = headers.get("x-vercel-signature");
    if (!signature) return { kind: "rejected", status: 401, message: "Missing X-Vercel-Signature header" };
    const expected = createHmac("sha1", config.secret).update(rawBody, "utf8").digest("hex");
    if (!safeEqual(signature, expected)) return { kind: "rejected", status: 401, message: "Signature mismatch" };

    let body: Payload;
    try {
      const value: unknown = JSON.parse(rawBody);
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
      body = value as Payload;
    } catch {
      return { kind: "rejected", status: 400, message: "Body must be a JSON object" };
    }

    const type = str(body.type);
    if (!type) return { kind: "rejected", status: 400, message: "Missing `type` in body" };
    if (!config.events.includes("*") && !config.events.includes(type)) {
      return { kind: "rejected", status: 422, message: `event "${type}" not enabled for this inbox` };
    }
    const id = str(body.id);
    if (!id) return { kind: "rejected", status: 400, message: "Missing `id` in body" };

    const payload = body.payload;
    const first = (paths: string[]) => paths.map((p) => str(get(payload, p))).find(Boolean);
    const project = first(PROJECT_PATHS);
    const team = first(TEAM_PATHS);
    const source = project ? `${API}/v9/projects/${project}` : team ? `${API}/v2/teams/${team}` : "https://vercel.com";
    const subject = first(SUBJECTS.find(([prefix]) => type.startsWith(prefix))![1]) ?? id;
    const time = toIso(body.createdAt) ?? receivedAt.toISOString();

    return {
      kind: "event",
      event: makeCloudEvent({
        specversion: "1.0",
        id,
        source,
        type: `com.vercel.${type}`,
        subject,
        time,
        datacontenttype: "application/json",
        data: body,
      }),
    };
  },
};

/** Vercel documents createdAt as both a millisecond timestamp and an ISO string. */
function toIso(v: unknown): string | undefined {
  if (typeof v !== "number" && typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
