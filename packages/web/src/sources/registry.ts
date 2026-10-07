import type { SourceAdapter } from "./types.js";

/** Looks up source adapters by type. Callers go through this and never name a source themselves. */
export class SourceRegistry {
  private readonly byType = new Map<string, SourceAdapter<any>>();

  constructor(adapters: SourceAdapter<any>[]) {
    for (const a of adapters) {
      if (this.byType.has(a.type)) throw new Error(`Source type "${a.type}" is registered twice`);
      this.byType.set(a.type, a);
    }
  }

  get(type: string): SourceAdapter<unknown> | undefined {
    return this.byType.get(type);
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
