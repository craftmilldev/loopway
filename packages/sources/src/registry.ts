import type { CloudEvent, SourceAdapter } from "./types.js";

/** Looks up source adapters by type. Callers go through this and never name a source themselves. */
export class SourceRegistry {
  // Each adapter has its own config type, which it both takes and returns, so only `any` holds them all.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly byType = new Map<string, SourceAdapter<any>>();

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  constructor(adapters: SourceAdapter<any>[]) {
    for (const a of adapters) {
      if (this.byType.has(a.type)) throw new Error(`Source type "${a.type}" is registered twice`);
      this.byType.set(a.type, a);
    }
  }

  get(type: string): SourceAdapter<unknown> | undefined {
    return this.byType.get(type);
  }

  /** The event's one-line summary, or null if its source has none (or isn't registered). */
  summarize(type: string, event: CloudEvent): string | null {
    return this.byType.get(type)?.summarize(event) ?? null;
  }

  /** The title the event carries, or null. */
  title(type: string, event: CloudEvent): string | null {
    return this.byType.get(type)?.title(event) ?? null;
  }

  /**
   * The event name for a test message to an inbox: the source's first sample type the inbox's `events` filter lets
   * through. Undefined when the source has no sample or the filter lets none through.
   */
  sampleType(type: string, config: { events?: string[] }): string | undefined {
    const events = config.events ?? ["*"];
    return this.byType
      .get(type)
      ?.sampleTypes?.(config)
      .find((t) => events.includes("*") || events.includes(t));
  }

  types(): string[] {
    return [...this.byType.keys()];
  }

  /** What clients need to build a create form or prompt for each source (`GET /sources`). */
  describe() {
    return [...this.byType.values()].map((s) => ({
      type: s.type,
      label: s.label,
      type_prefix: s.typePrefix,
      description: s.description,
      events: s.events,
      secret:
        s.secret.from === "loopway" ? { from: s.secret.from, min_length: s.secret.minLength } : { from: s.secret.from },
      webhook_settings: s.webhookSettings,
    }));
  }
}
