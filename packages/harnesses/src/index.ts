import type { AgentRun, RunAgent } from "./agent.js";
import type { Harness } from "./harness.js";
import { ClaudeHarness } from "./claude.js";
import { CodexHarness } from "./codex.js";
import { CursorHarness } from "./cursor.js";
import { HermesHarness } from "./hermes.js";
import { ScriptHarness } from "./script.js";

/** Every harness a bot can run on. A new one is one class and one line here. */
export const HARNESSES: Harness[] = [
  new ClaudeHarness(),
  new CursorHarness(),
  new CodexHarness(),
  new HermesHarness(),
  new ScriptHarness(),
];

export function getHarness(name: string): Harness {
  const harness = HARNESSES.find((h) => h.name === name);
  if (!harness) throw new Error(`Unknown harness "${name}" (known: ${HARNESSES.map((h) => h.name).join(", ")})`);
  return harness;
}

/** Runs the session with the harness the run names. */
export const runHarness: RunAgent = (run: AgentRun) => getHarness(run.harness).run(run);

export { Harness } from "./harness.js";
export { HARNESS_LABELS } from "./labels.js";
export type { Launch } from "./harness.js";
export type { TranscriptLine } from "./transcript.js";
export type { AgentRun, RunAgent, RunOutcome, RunWatch } from "./agent.js";
export { reportPlanUsage, planUsageTarget, planUsageBody } from "./plan-usage.js";
export type { PlanUsageOutcome, RateLimitInfo } from "./plan-usage.js";
