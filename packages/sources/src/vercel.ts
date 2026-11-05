import { createHmac } from "node:crypto";
import { get, str, type Payload } from "./payload.js";
import type { SourceAdapter, SourceDeps } from "./types.js";

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

/**
 * Payload paths tried in order for `subject`, keyed by event type or type prefix. The longest key
 * the type starts with wins, so `deployment.rollback` beats `deployment.`.
 */
const SUBJECTS: Record<string, string[]> = {
  "alerts.": ["groupId"],
  "deployment.": ["deployment.id"],
  "deployment.rollback": ["toDeploymentId"],
  "domain.": ["domain.name"],
  "domain.certificate-": ["cert.id", "dnsNames.0"],
  "domain.dns-records-changed": ["zone"],
  "flag.": ["flag.id"],
  "flag.segment.": ["segment.id"],
  "integration-configuration.": ["configuration.id"],
  "integration-resource.": ["resourceId"],
  "marketplace.invoice.": ["invoiceId"],
  "marketplace.member.": ["memberId"],
  "project.": ["project.id"],
  "project.domain.": ["domain.name"],
  "project.domain.updated": ["previous.domain", "next.domain"],
  "project.env-variable.": ["envVarId"],
  "project.rolling-release.": ["rollingRelease.default.targetDeploymentId"],
};
/** For types not in SUBJECTS. */
const FALLBACK_SUBJECT = ["deployment.id", "project.id", "projectId"];

function subjectPaths(type: string): string[] {
  const key = Object.keys(SUBJECTS)
    .filter((k) => type.startsWith(k))
    .reduce((a, b) => (b.length > a.length ? b : a), "");
  return SUBJECTS[key] ?? FALLBACK_SUBJECT;
}

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

export const vercel = ({ safeEqual, makeCloudEvent }: SourceDeps): SourceAdapter => ({
  type: "vercel",
  label: "Vercel",
  description: "Vercel account/integration webhooks, verified with X-Vercel-Signature.",
  // Vercel makes the secret when the webhook is added, so it's set afterwards.
  secret: { from: "sender" },
  webhookSettings: "Vercel → Team Settings → Webhooks",

  claims: (headers) => headers.has("x-vercel-signature"),

  receive({ headers, rawBody, receivedAt }, secret) {
    const signature = headers.get("x-vercel-signature");
    if (!signature) return { kind: "rejected", status: 401, message: "Missing X-Vercel-Signature header" };
    const expected = createHmac("sha1", secret).update(rawBody, "utf8").digest("hex");
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
    const id = str(body.id);
    if (!id) return { kind: "rejected", status: 400, message: "Missing `id` in body" };

    const payload = body.payload;
    const first = (paths: string[]) => paths.map((p) => str(get(payload, p))).find(Boolean);
    const project = first(PROJECT_PATHS);
    const team = first(TEAM_PATHS);
    const source = project ? `${API}/v9/projects/${project}` : team ? `${API}/v2/teams/${team}` : "https://vercel.com";
    const subject = first(subjectPaths(type)) ?? id;
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
});

/** Vercel documents createdAt as both a millisecond timestamp and an ISO string. */
function toIso(v: unknown): string | undefined {
  if (typeof v !== "number" && typeof v !== "string") return undefined;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}
