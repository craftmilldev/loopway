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

  /** Who made the event, or null if its source can't tell (or isn't registered). */
  author(type: string, event: CloudEvent): "human" | "bot" | null {
    return this.byType.get(type)?.author?.(event) ?? null;
  }

  types(): string[] {
    return [...this.byType.keys()];
  }

  /** What clients need to build a create form or prompt for each source (`GET /sources`). */
  describe() {
    return [...this.byType.values()].map((s) => ({
      type: s.type,
      label: s.label,
      description: s.description,
      events: s.events,
      secret:
        s.secret.from === "loopway" ? { from: s.secret.from, min_length: s.secret.minLength } : { from: s.secret.from },
      webhook_settings: s.webhookSettings,
    }));
  }
}
