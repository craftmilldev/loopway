---------------------------- MODULE cursor ----------------------------
(***************************************************************************)
(* Reading an inbox with a cursor: senders insert messages while a reader  *)
(* pages through them, moving its cursor past each one. ../SKILL.md says   *)
(* which code each action stands for.                                      *)
(*                                                                         *)
(* Messages are numbers. A message's number is also its rank among         *)
(* messages with the same timestamp, like a tie-break on `id`.             *)
(***************************************************************************)
EXTENDS Naturals, Sequences, FiniteSets

CONSTANTS
    MessageCount,   \* how many messages may be sent
    MaxTime,        \* the clock stops here
    Page,           \* the most rows one read returns
    Inclusive,      \* a bug: TRUE drops the `after` id, leaving `>=` on the timestamp
    HoldBack,       \* a read stops at head, this many ticks behind the clock
    MaxCommitLag,   \* the most ticks a row stays uncommitted. An assumption
    CursorFirst,    \* a bug: TRUE writes the cursor before the handler runs
    MoveOnFullPage, \* a bug: TRUE moves the cursor to head even with rows left
    MaxCrashes      \* how many times the handler may throw or the process die

VARIABLES
    now,            \* Postgres's clock
    status,         \* "unsent", "open" or "committed"
    stamp,          \* received_at, or the time in a UUIDv7: set at the insert's start
    handled,        \* messages whose handler resolved
    advanced,       \* messages the saved cursor moved past after they resolved
    cursorTime,     \* the cursor: a timestamp
    cursorRank,     \* the cursor: a tie-break
    batch,          \* rows read and not yet finished, oldest first
    nextHead,       \* where the cursor goes after this batch, or None
    phase,          \* the reader: "ready", "called" or "resolved"
    crashes,        \* failures so far
    needlessRepeat  \* a handler ran again with no failure to explain it

vars == <<now, status, stamp, handled, advanced, cursorTime, cursorRank,
          batch, nextHead, phase, crashes, needlessRepeat>>

Messages == 1..MessageCount

None == 1000  \* no time in the model reaches this

HeadTime == IF now >= HoldBack THEN now - HoldBack ELSE 0

\* Whether a read from this cursor can still return the message.
Reachable(m) ==
    IF Inclusive
    THEN stamp[m] >= cursorTime
    ELSE \/ stamp[m] > cursorTime
         \/ stamp[m] = cursorTime /\ m > cursorRank

Before(a, b) == stamp[a] < stamp[b] \/ (stamp[a] = stamp[b] /\ a < b)

RECURSIVE Ordered(_)
Ordered(rows) ==
    IF rows = {} THEN <<>>
    ELSE LET first == CHOOSE x \in rows : \A y \in rows \ {x} : Before(x, y)
         IN <<first>> \o Ordered(rows \ {first})

Rows == {m \in Messages : /\ status[m] = "committed"
                          /\ Reachable(m)
                          /\ stamp[m] < HeadTime}

Take(rows, n) == SubSeq(rows, 1, IF Len(rows) < n THEN Len(rows) ELSE n)

InBatch(m) == \E i \in 1..Len(batch) : batch[i] = m

Init ==
    /\ now = 0
    /\ status = [m \in Messages |-> "unsent"]
    /\ stamp = [m \in Messages |-> 0]
    /\ handled = {}
    /\ advanced = {}
    /\ cursorTime = 0
    /\ cursorRank = 0
    /\ batch = <<>>
    /\ nextHead = None
    /\ phase = "ready"
    /\ crashes = 0
    /\ needlessRepeat = FALSE

\* The clock can't pass an insert's commit deadline: that's what MaxCommitLag assumes.
ClockTicks ==
    /\ now < MaxTime
    /\ \A m \in Messages : status[m] = "open" => now + 1 - stamp[m] <= MaxCommitLag
    /\ now' = now + 1
    /\ UNCHANGED <<status, stamp, handled, advanced, cursorTime, cursorRank,
                   batch, nextHead, phase, crashes, needlessRepeat>>

\* Late sends are left out so a message's hold-back can pass before the clock stops.
InsertStarts(m) ==
    /\ status[m] = "unsent"
    /\ now + HoldBack + MaxCommitLag + 1 <= MaxTime
    /\ status' = [status EXCEPT ![m] = "open"]
    /\ stamp' = [stamp EXCEPT ![m] = now]
    /\ UNCHANGED <<now, handled, advanced, cursorTime, cursorRank, batch,
                   nextHead, phase, crashes, needlessRepeat>>

InsertCommits(m) ==
    /\ status[m] = "open"
    /\ status' = [status EXCEPT ![m] = "committed"]
    /\ UNCHANGED <<now, stamp, handled, advanced, cursorTime, cursorRank,
                   batch, nextHead, phase, crashes, needlessRepeat>>

\* One call to readMessages. Reading to the end also says to move up to head.
ReaderReads ==
    /\ batch = <<>>
    /\ nextHead = None
    /\ phase = "ready"
    /\ Rows # {} \/ HeadTime > cursorTime
    /\ batch' = Take(Ordered(Rows), Page)
    /\ nextHead' = IF MoveOnFullPage \/ Cardinality(Rows) <= Page THEN HeadTime ELSE None
    /\ UNCHANGED <<now, status, stamp, handled, advanced, cursorTime,
                   cursorRank, phase, crashes, needlessRepeat>>

HandlerCalled ==
    /\ batch # <<>>
    /\ phase = "ready"
    /\ phase' = "called"
    /\ needlessRepeat' = (needlessRepeat \/ Head(batch) \in advanced)
    /\ IF CursorFirst
       THEN /\ cursorTime' = stamp[Head(batch)]
            /\ cursorRank' = Head(batch)
       ELSE UNCHANGED <<cursorTime, cursorRank>>
    /\ UNCHANGED <<now, status, stamp, handled, advanced, batch, nextHead, crashes>>

HandlerResolves ==
    /\ phase = "called"
    /\ phase' = "resolved"
    /\ handled' = handled \cup {Head(batch)}
    /\ UNCHANGED <<now, status, stamp, advanced, cursorTime, cursorRank, batch,
                   nextHead, crashes, needlessRepeat>>

CursorWritten ==
    /\ phase = "resolved"
    /\ phase' = "ready"
    /\ cursorTime' = stamp[Head(batch)]
    /\ cursorRank' = Head(batch)
    /\ advanced' = advanced \cup {Head(batch)}
    /\ batch' = Tail(batch)
    /\ UNCHANGED <<now, status, stamp, handled, nextHead, crashes, needlessRepeat>>

\* `drain` after a page: the cursor takes next_since and next_after. A rank of 0 is
\* `after: null`, so rows at head itself are still ahead of it.
CursorMovesToHead ==
    /\ batch = <<>>
    /\ phase = "ready"
    /\ nextHead # None
    /\ cursorTime' = nextHead
    /\ cursorRank' = 0
    /\ nextHead' = None
    /\ UNCHANGED <<now, status, stamp, handled, advanced, batch, phase, crashes,
                   needlessRepeat>>

\* The handler throws, or the process dies. The run stops, and the batch is gone.
ReaderCrashes ==
    /\ phase \in {"called", "resolved"}
    /\ crashes < MaxCrashes
    /\ phase' = "ready"
    /\ batch' = <<>>
    /\ nextHead' = None
    /\ crashes' = crashes + 1
    /\ UNCHANGED <<now, status, stamp, handled, advanced, cursorTime,
                   cursorRank, needlessRepeat>>

Next ==
    \/ ClockTicks
    \/ \E m \in Messages : InsertStarts(m)
    \/ \E m \in Messages : InsertCommits(m)
    \/ ReaderReads
    \/ HandlerCalled
    \/ HandlerResolves
    \/ CursorWritten
    \/ CursorMovesToHead
    \/ ReaderCrashes

\* Crashes and new sends may never happen. Everything else eventually does.
Spec ==
    /\ Init
    /\ [][Next]_vars
    /\ WF_vars(ClockTicks)
    /\ \A m \in Messages : WF_vars(InsertCommits(m))
    /\ WF_vars(ReaderReads)
    /\ WF_vars(HandlerCalled)
    /\ WF_vars(HandlerResolves)
    /\ WF_vars(CursorWritten)
    /\ WF_vars(CursorMovesToHead)

\* A row in the current batch is still on its way to the handler.
NoSkip ==
    \A m \in Messages :
        status[m] = "committed" => (m \in handled \/ InBatch(m) \/ Reachable(m))

NoNeedlessRepeat == ~needlessRepeat

Delivered == \A m \in Messages : (status[m] = "committed") ~> (m \in handled)
========================================================================
