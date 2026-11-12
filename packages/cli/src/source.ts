/** A thing people collaborate on: an issue or a pull request. Keyed `owner/repo#N`. */
export interface Subject {
  key: string;
  kind: "issue" | "pull_request";
  title: string;
  author: string;
  /** ISO time the subject was created. */
  createdAt: string;
  /** ISO time of its last activity (a comment, an assignment, a close or reopen), when the source says. */
  updatedAt?: string;
  /** Whether it is open or closed (a merged pull request is closed), when the source says. */
  open?: boolean;
  /** Logins it is assigned to, as read when it was found or created. */
  assignees?: string[];
  /** Its text, only when it was just read from the source: the poller doesn't keep it. */
  body?: string;
}

/** A subject loopway just created for a thread, and where to read it. */
export interface Made {
  subject: Subject;
  url: string;
}

/** One thing that happened to a subject. `id` is stable, so seeing it twice is how a repeat is spotted. */
export interface Update {
  id: string;
  /** "comment", "review", "closed", "labeled", "check_run" ... */
  kind: string;
  detail?: string;
  /** The text of a comment or review, for whoever reads the update. */
  body?: string;
  actor: string;
  /** ISO time it happened. */
  at: string;
}

/** What asking a subject for updates returned: its updates, plus where it stands now. */
export interface Updates {
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
  /**
   * Issues and pull requests in `repo` created or active since `since`, newest first or not; the caller filters by
   * author. An old subject someone just touched comes back, which is how loopway picks up one older than itself.
   */
  discover(repo: string, since: string): Promise<Subject[]>;
  /**
   * Optional, cheap, and batched: which of these subjects have something new since they were last polled. The poller
   * polls only those. A source without it is polled for every subject. It may over-report; it must not under-report.
   */
  changed?(subjects: Subject[]): Promise<Set<string>>;
  /** The logins in a team (`org/slug`). Fails when the team can't be read, which is why loopway then won't run. */
  teamMembers?(team: string): Promise<string[]>;
  /** The reactions on a comment, by its URL. */
  reactions(commentUrl: string): Promise<Reaction[]>;
  /** Everything visible about a subject. Repeats are fine: the poller drops ids it has seen. */
  updates(subject: Subject, version?: string): Promise<Updates>;
}

/** One reaction on a comment: GitHub's `content` (`+1`, `-1`, `heart`...) and who left it. */
export interface Reaction {
  content: string;
  user: string;
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

/** What a thread says when it creates an issue: `subscribe` is required, so it must say whether it tracks it. `assign` starts work on it. */
export interface IssueOptions {
  subscribe: boolean;
  assign?: boolean;
}
