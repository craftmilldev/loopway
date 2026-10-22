/** What a Claude Code `rate_limit_event` carries (the parts we use). */
export interface RateLimitInfo {
  status?: string;
  resetsAt?: number;
  rateLimitType?: string;
  unifiedWindows?: Record<string, { utilization?: number; resetsAt?: number } | undefined>;
}

/** How a report ended, for product metrics: it went out, it failed, or the configured protocol isn't supported. */
export type PlanUsageOutcome = "sent" | "failed" | "unsupported_protocol";

/** Longest a report waits for the endpoint. */
export const PLAN_USAGE_TIMEOUT_MS = 3000;
/** At most one report this often, unless the run was rejected. */
export const PLAN_USAGE_INTERVAL_MS = 60_000;

const WINDOW_NAMES: Record<string, string> = { five_hour: "5h", seven_day: "7d" };

interface Target {
  url: string;
  headers: Record<string, string>;
  resource: Record<string, string>;
}

/** Splits `a=b,c=d` (the OTEL_* list format, values percent-encoded) into pairs. */
function pairs(list: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const item of (list ?? "").split(",")) {
    const i = item.indexOf("=");
    if (i < 1) continue;
    try {
      out[decodeURIComponent(item.slice(0, i).trim())] = decodeURIComponent(item.slice(i + 1).trim());
    } catch {
      // A malformed escape: skip the pair.
    }
  }
  return out;
}

/** Where plan usage goes, from the standard OTEL_EXPORTER_OTLP_* variables; undefined when nothing is configured. */
export function planUsageTarget(env: NodeJS.ProcessEnv): Target | "unsupported_protocol" | undefined {
  if (env.OTEL_SDK_DISABLED?.toLowerCase() === "true" || env.OTEL_METRICS_EXPORTER?.toLowerCase() === "none") return;
  const metrics = env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT;
  const base = env.OTEL_EXPORTER_OTLP_ENDPOINT;
  const url = metrics || (base ? `${base.replace(/\/+$/, "")}/v1/metrics` : undefined);
  if (!url) return;
  // Reports are OTLP/HTTP with a JSON body; gRPC has no equivalent here.
  const protocol = env.OTEL_EXPORTER_OTLP_METRICS_PROTOCOL || env.OTEL_EXPORTER_OTLP_PROTOCOL;
  if (protocol === "grpc") return "unsupported_protocol";
  return {
    url,
    headers: { ...pairs(env.OTEL_EXPORTER_OTLP_HEADERS), ...pairs(env.OTEL_EXPORTER_OTLP_METRICS_HEADERS) },
    resource: pairs(env.OTEL_RESOURCE_ATTRIBUTES),
  };
}

const attr = (key: string, value: string | number) => ({
  key,
  value: typeof value === "number" ? { intValue: String(value) } : { stringValue: value },
});

/** The OTLP/JSON body for one snapshot: a `plan.usage.utilization` point per window that reports a utilization. */
export function planUsageBody(info: RateLimitInfo, sessionId: string, resource: Record<string, string>, now: number) {
  const status = info.status === "allowed" || info.status === "allowed_warning" || info.status === "rejected";
  const windows = Object.entries(info.unifiedWindows ?? {}).filter(
    (e): e is [string, { utilization: number; resetsAt?: number }] => typeof e[1]?.utilization === "number",
  );
  // A rejected event without per-window data still says which window is full, and when it resets.
  if (!windows.length && info.status === "rejected" && info.rateLimitType)
    windows.push([info.rateLimitType, { utilization: 1, resetsAt: info.resetsAt }]);
  const points = windows.map(([name, w]) => ({
    asDouble: Math.min(Math.max(w.utilization, 0), 1),
    timeUnixNano: String(now * 1_000_000),
    attributes: [
      attr("plan.window", WINDOW_NAMES[name] ?? name),
      ...(typeof w.resetsAt === "number" ? [attr("plan.resets_at", w.resetsAt)] : []),
      attr("plan.provider", "anthropic"),
      attr("session.id", sessionId),
      // The event's status is about the window it names, so only that window gets it.
      ...(status && name === info.rateLimitType ? [attr("plan.status", info.status!)] : []),
    ],
  }));
  if (!points.length) return undefined;
  return {
    resourceMetrics: [
      {
        resource: {
          attributes: Object.entries({ "service.name": "loopway", ...resource }).map(([k, v]) => attr(k, v)),
        },
        scopeMetrics: [
          {
            scope: { name: "loopway.plan-usage" },
            metrics: [
              {
                name: "plan.usage.utilization",
                description: "Share of a plan usage window used, from 0 to 1.",
                unit: "1",
                gauge: { dataPoints: points },
              },
            ],
          },
        ],
      },
    ],
  };
}

let lastSent = -Infinity;
let warned = false;

/** Forgets the throttle and the once-only warning, for tests. */
export function resetPlanUsage(): void {
  lastSent = -Infinity;
  warned = false;
}

/**
 * Reports a plan usage snapshot as OTLP metrics, if OTEL_EXPORTER_OTLP_* says where. Fire and forget: it never
 * throws and never waits longer than the timeout. Throttled to one report a minute (this runner is one account),
 * except a rejected one, which always goes. A failing endpoint is logged once.
 */
export async function reportPlanUsage(
  info: RateLimitInfo,
  sessionId: string,
  env: NodeJS.ProcessEnv,
  opts: { now?: number; fetch?: typeof fetch; warn?: (message: string) => void } = {},
): Promise<PlanUsageOutcome | undefined> {
  try {
    const target = planUsageTarget(env);
    if (!target) return undefined;
    if (target === "unsupported_protocol") return "unsupported_protocol";
    const now = opts.now ?? Date.now();
    const rejected = info.status === "rejected";
    if (!rejected && now - lastSent < PLAN_USAGE_INTERVAL_MS) return undefined;
    const body = planUsageBody(info, sessionId, target.resource, now);
    if (!body) return undefined;
    lastSent = now;
    try {
      const res = await (opts.fetch ?? fetch)(target.url, {
        method: "POST",
        headers: { ...target.headers, "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PLAN_USAGE_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return "sent";
    } catch (err) {
      if (!warned) {
        warned = true;
        (opts.warn ?? console.warn)(
          `plan usage: could not report to the OTLP endpoint (${err instanceof Error ? err.message : String(err)}); further failures are not logged`,
        );
      }
      return "failed";
    }
  } catch {
    return undefined;
  }
}
