import { beforeEach, describe, expect, it, vi } from "vitest";
import { LimitWatch } from "../src/claude-watch.js";
import { planUsageBody, planUsageTarget, reportPlanUsage, resetPlanUsage } from "../src/plan-usage.js";

const info = {
  status: "allowed",
  resetsAt: 1791565200,
  rateLimitType: "five_hour",
  unifiedWindows: {
    five_hour: { utilization: 0.02, resetsAt: 1791565200 },
    seven_day: { utilization: 0.21, resetsAt: 1791795600 },
    seven_day_overage_included: { utilization: 0.2, resetsAt: 1791795600 },
  },
};
const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://localhost:4318/" };

describe("plan usage over OTLP", () => {
  beforeEach(resetPlanUsage);

  it("sends nothing unless OTEL_EXPORTER_OTLP_* names an endpoint, or when the SDK is disabled", async () => {
    const fetch = vi.fn();
    expect(await reportPlanUsage(info, "s1", {}, { fetch })).toBeUndefined();
    expect(await reportPlanUsage(info, "s1", { ...env, OTEL_SDK_DISABLED: "true" }, { fetch })).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves the endpoint, headers and resource from the standard variables", () => {
    expect(planUsageTarget({ ...env, OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "http://m/x" })).toMatchObject({
      url: "http://m/x",
    });
    expect(
      planUsageTarget({
        ...env,
        OTEL_EXPORTER_OTLP_HEADERS: "a=1,b=two%20words",
        OTEL_EXPORTER_OTLP_METRICS_HEADERS: "a=2",
        OTEL_RESOURCE_ATTRIBUTES: "team=x",
      }),
    ).toEqual({
      url: "http://localhost:4318/v1/metrics",
      headers: { a: "2", b: "two words" },
      resource: { team: "x" },
    });
    expect(planUsageTarget({ ...env, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" })).toBe("unsupported_protocol");
  });

  it("throttles the unsupported protocol outcome too", async () => {
    const grpc = { ...env, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" };
    expect(await reportPlanUsage(info, "s1", grpc, { now: 0 })).toBe("unsupported_protocol");
    expect(await reportPlanUsage(info, "s1", grpc, { now: 1000 })).toBeUndefined();
  });

  it("builds one point per window with the plan.* attributes", () => {
    const body = planUsageBody(info, "s1", { team: "x" }, 1000)!;
    const rm = body.resourceMetrics[0]!;
    expect(rm.resource.attributes.map((a) => a.key)).toEqual(["service.name", "team"]);
    const metric = rm.scopeMetrics[0]!.metrics[0]!;
    expect(metric.name).toBe("plan.usage.utilization");
    const points = metric.gauge.dataPoints;
    expect(points.map((p) => [p.attributes[0]!.value, p.asDouble])).toEqual([
      [{ stringValue: "5h" }, 0.02],
      [{ stringValue: "7d" }, 0.21],
      [{ stringValue: "seven_day_overage_included" }, 0.2],
    ]);
    expect(points[0]!.attributes.map((a) => a.key)).toEqual([
      "plan.window",
      "plan.resets_at",
      "plan.provider",
      "session.id",
      "plan.status",
    ]);
    expect(points[1]!.attributes.map((a) => a.key)).not.toContain("plan.status");
    // A rejected event with no per-window data still reports the full window.
    const full = planUsageBody({ status: "rejected", resetsAt: 5, rateLimitType: "seven_day" }, "s1", {}, 1)!;
    expect(full.resourceMetrics[0]!.scopeMetrics[0]!.metrics[0]!.gauge.dataPoints[0]!.asDouble).toBe(1);
    expect(planUsageBody({ status: "allowed" }, "s1", {}, 1)).toBeUndefined();
  });

  it("posts the snapshot, throttled to once a minute unless rejected", async () => {
    const fetch = vi.fn(async () => new Response("{}", { status: 200 }));
    const send = (i: object, now: number) => reportPlanUsage(i, "s1", env, { fetch, now });
    expect(await send(info, 0)).toBe("sent");
    expect(fetch).toHaveBeenCalledWith("http://localhost:4318/v1/metrics", expect.objectContaining({ method: "POST" }));
    expect(await send(info, 30_000)).toBeUndefined();
    expect(await send({ ...info, status: "rejected" }, 31_000)).toBe("sent");
    expect(await send(info, 61_000)).toBeUndefined();
    expect(await send(info, 91_001)).toBe("sent");
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it("never throws on a down endpoint and logs it once", async () => {
    const fetch = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const warn = vi.fn();
    expect(await reportPlanUsage(info, "s1", env, { fetch, warn, now: 0 })).toBe("failed");
    expect(await reportPlanUsage(info, "s1", env, { fetch, warn, now: 100_000 })).toBe("failed");
    expect(warn).toHaveBeenCalledTimes(1);
    const bad = vi.fn(async () => new Response("no", { status: 500 }));
    resetPlanUsage();
    expect(await reportPlanUsage(info, "s1", env, { fetch: bad, warn, now: 0 })).toBe("failed");
  });

  it("LimitWatch hands every rate_limit_event to the reporter", () => {
    const seen: string[] = [];
    const w = new LimitWatch(undefined, (i) => seen.push(i.status ?? ""));
    w.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: info }));
    w.line(JSON.stringify({ type: "rate_limit_event", rate_limit_info: { status: "rejected", resetsAt: 1 } }));
    expect(seen).toEqual(["allowed", "rejected"]);
  });
});
