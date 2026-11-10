/** A thing people collaborate on: an issue or a pull request. Keyed `owner/repo#N`. */
export interface Subject {
  key: string;
  kind: "issue" | "pull_request";
  title: string;
  author: string;
  /** ISO time the subject was created. */
  createdAt: string;
}

/** One thing that happened to a subject. `id` is stable, so seeing it twice is how a repeat is spotted. */
export interface Update {
  id: string;
  /** "comment", "review", "closed", "labeled", "check_run" ... */
  kind: string;
  detail?: string;
  actor: string;
  /** ISO time it happened. */
  at: string;
}

/** What polling a subject returned: its updates, plus where it stands now. */
export interface Poll {
  updates: Update[];
  /** Opaque; hand it back on the next poll. A source uses it to skip work when nothing changed. */
  version?: string;
}

/**
 * Where subjects come from. GitHub is the only one for now; the poller only knows this interface, so the tests use a
 * fake and another tool could be added.
 */
export interface SubjectSource {
  /** Who the credentials belong to. */
  whoami(): Promise<string>;
  /** Issues and pull requests in `repo` created after `since`, newest first or not; the caller filters by author. */
  discover(repo: string, since: string): Promise<Subject[]>;
  /**
   * Optional, cheap, and batched: which of these subjects have something new since they were last polled. The poller
   * polls only those. A source without it is polled for every subject. It may over-report; it must not under-report.
   */
  changed?(subjects: Subject[]): Promise<Set<string>>;
  /** Everything visible about a subject. Repeats are fine: the poller drops ids it has seen. */
  poll(subject: Subject, version?: string): Promise<Poll>;
}

/** The source asked us to stop for a while. */
export class RateLimitError extends Error {
  constructor(
    /** Epoch milliseconds to wait until. */
    readonly resumeAt: number,
    message = "rate limited",
  ) {
    super(message);
  }
}
