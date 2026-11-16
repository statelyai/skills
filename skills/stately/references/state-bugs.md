# State bug kinds, evidence, and the lead ledger

Both [implicit-machines.md](implicit-machines.md) and
[state-review.md](state-review.md) use this file. It defines the kinds of state
bug to check, the evidence a finding needs, how to find absences, and how each
lead is closed.

A state bug needs a named state and an event or sequence. If a single call
with fresh state behaves correctly and the failure needs an earlier event, an
interleaving, or stored data from an earlier run, it is a state bug. A missing
null check on a fresh call is not.

## Kinds

Check every lead against every kind that applies. The kinds overlap; report a
bug once, under the kind that names its cause.

1. **Impossible states.** Flags or fields that must never coexist can: loading
   and error both true, `data` and `error` both set, a status that contradicts a
   flag, a selection that points at a deleted item. Boolean flags that encode
   one lifecycle allow 2^n combinations where the product has a few phases.
2. **Unchecked transitions.** A status changes without checking its source
   state, or a change removes such a check. An event is accepted in every phase
   instead of being ignored where it has no meaning. A guard exists only in the
   UI (a disabled button, a hidden menu item) while the handler, API, or worker
   accepts the same event in any phase: a double click, a keyboard shortcut, a
   retry, or a second tab reaches it. A write that replaces a status or flag
   without reading it erases whatever else set it: an independent failure, a
   user's choice, or a newer value.
3. **Unhandled states.** A new enum member, status string, union case, or
   message type is missing from a `switch`, map, filter, label, serializer,
   permission check, or analytics mapping. A `default` branch treats it as
   another state without saying so.
4. **Stuck states.** A loading, processing, locked, or busy value stays set
   after an error, early return, timeout, cancel, or unmount. A waiting state
   has no timeout and no exit event. An error state has no retry or recovery
   path, so only a reload leaves it. Run [exit parity](#find-absences).
5. **Event order.** The code assumes events arrive once and in order. Check a
   duplicate (webhook redelivery, double submit, at-least-once queues), a late
   arrival after the phase that expected it has ended, an out-of-order pair,
   and two overlapping starts. A slower earlier response overwriting a newer
   one (search as you type, autosave) belongs here, and so does a late
   completion that replaces a newer handle (a connection, subscription, or
   worker) without closing it. When code takes a snapshot of ids and acts on
   them later, check entities that joined after the snapshot and entities
   that left it for another owner. Deferred, batched, or coalesced work has
   its own orderings: a read right after the write sees the old value, a
   deferred action overrides an explicit one that follows it in the same
   batch, and coalescing drops relative updates (a delta, a toggle, a step).
6. **Check then act.** The code reads a phase, crosses an `await`, callback,
   IPC message, lock release, or transaction boundary, and then acts on the
   old reading. Look for generation, epoch, revision, request id, or
   AbortSignal checks that should follow the boundary and do not. A result
   that lands after its owner changed (another session, tab, user, document,
   or retry attempt) and is attributed to the new owner belongs here.
7. **Stale copies.** A value derived from other state is stored instead of
   computed, and one writer forgets to update it. A cache, mirror, index,
   counter, or metric drifts from its source. An optimistic update is not
   rolled back when the request fails. Two modules derive the same phase from
   different inputs and disagree about when it starts or ends.
8. **Lifecycle order.** Use before init, use after close, dispose, or unmount,
   or teardown that never runs. Work started in a phase (a promise, timer,
   interval, subscription, listener, child process, socket, or spawned task)
   outlives that phase and writes into a later one. A start path and its stop
   path can interleave. Detached work that holds temporary global state until
   its `finally` (renamed files, environment variables, the working directory,
   a global flag) exposes that state to everything that runs meanwhile. Check
   startup, import, recovery, reconnect, and shutdown orderings, not only the
   steady state.
9. **Stored state.** A persisted shape changes without a migration or version
   check, so old data meets new code. Rehydration restores an in-flight or
   impossible phase (a persisted `loading`, a lock owned by a dead process).
   A state write and its side effect are separated, so a crash between them
   leaves one without the other (email sent but order not marked, row marked
   but message not sent). Per-item writes or effects in a loop (rows, emitted
   jobs, sent messages) have no transaction or checkpoint, so a crash midway
   leaves a prefix, and a retry that skips already-done work skips the rest.
   A write that reuses an existing file, row, or key without truncating or
   clearing it keeps stale content from an earlier run. A write that adds a new
   version (a row, snapshot, or file) without removing or superseding the old
   one lets a reader that does not order versions pick the old one.
10. **Retries and timers.** A retry has no bound, continues after cancel or
    success, or retries a non-idempotent effect. A timer, debounce, or
    throttle is not cleared when its phase ends, so it fires in a later one.
    Backoff or attempt state is shared across entities that should each own
    one.
11. **Hidden modes.** One event or input means different things depending on
    an implicit mode (editing, dragging, modal open, offline, read-only,
    impersonating), and one handler ignores the mode. The mode is not reset
    when the user leaves the feature, navigates back, or switches documents.
12. **Error paths.** A non-fatal error is signalled and then mishandled. A
    `catch`, `except`, `.catch`, `if err != nil`, or error callback only logs,
    swallows, returns a default, or holds a TODO, and leaves partial state
    behind. One sibling handles an error that another sibling ignores. An
    error thrown from cleanup skips the rest of the cleanup.

## Find absences

The bugs that reviews miss most are lines that are not there: a missing
reset, migration, transaction, or companion call. Reading the changed lines
does not find them. Compare instead:

- **Exit parity.** For each function or handler that sets a busy flag, lock,
  status, counter, listener, or resource, list every exit: normal return,
  early return, `throw`, rejected `await`, `catch`, `break` or `continue` out
  of a loop, error callback, cancel, timeout, and unmount. Mark each exit as
  restoring the value or not. A reset in `finally`, a `defer`, a `using`
  block, or a destructor covers every exit after it is set; a reset at the end
  of the happy path covers only that path.
- **Sibling parity.** List every writer of the same state value. Compare the
  companion calls each one makes: save or persist, notify or emit, invalidate a
  cache, bump a revision, increment and decrement, acquire and release,
  subscribe and unsubscribe, start and stop. A writer that skips a call its
  siblings make is a finding by default. Clearing it needs a cited reason that
  the companion is unnecessary on every path, including restart and reload.
- **Pair parity.** When the code already has both sides of a pair (`inc` and
  `dec`, `add` and `remove`, `open` and `close`, `setX(true)` and
  `setX(false)`), check that every path that runs one side also runs the
  other. A value with only one side anywhere is usually monotonic by design:
  a total, an id, a sequence number, an append-only log. It is a lead only
  when its readers treat it as a current level, such as an in-flight count, a
  gauge shown as "currently broken", a refcount, or a lock.
- **Inverse parity.** For each operation and its undo (invalidate and
  reconsider, archive and restore, mark and unmark, connect and close), list
  what the forward side writes, including derived flags on other entities.
  When the change adds a forward write, check that the inverse clears it.
- **New-path parity.** When the change adds a path that does what an existing
  path does (a bulk version of a single action, a new entry point, a fast
  path, a cached or no-op branch), list the effects of the existing path:
  cache invalidation on client and server, hooks, events, progress, metrics,
  audit, cleanup. Check each one on the new path.
- **Case parity.** For a new enum member or status value, list every place
  that branches on its siblings and check it there.
- **Client parity.** When the change adds or alters a shared mechanism
  (deferral, coalescing, batching, a cache, a lock, a queue, a retry policy),
  list every client of that mechanism and check each one. Clearing one client
  does not clear the others; each one gets its own ledger row.
- **Loop writes.** A loop that writes persistent state per item without a
  transaction, batch, or resumable marker is a partial-failure lead.

`scripts/state-leads.mjs` prints the writers, readers, exit-parity hints,
removed guards and resets, and detached async work (including removed
`await`s) for a diff. Use its output instead of repeating the same searches by hand.

## Evidence for a finding

A finding names all of these. Without them it is a question, not a finding.

- **State:** the phase or value combination, in the product's words, and the
  variables that hold it.
- **Event:** what triggers the failure, such as a server reply with no URL, a
  second webhook delivery, or Escape during a stream.
- **Sequence:** numbered steps from an entry point a user, client, scheduler,
  or peer can reach, with `path:line` for each step.
- **Acting line:** the line that acts on the state without the needed check,
  reset, or companion call.
- **Consequence:** what the user, data, or system ends up with, such as a
  button disabled until reload, a double charge, or a gauge that never
  decrements.

## Verify before reporting

Re-trace each finding from its cited lines with fresh reads. When the host can
delegate, give the finding alone (not the reasoning that produced it) to a
separate reader, and have it confirm each step. Drop a finding when a step
fails: the entry point cannot reach it, a guard or `finally` blocks it, or the
cited line says something else. When a step depends on behavior outside the
source (a framework guarantee, a server contract, delivery semantics), cite
the documentation or mark the step assumed. A finding that keeps an assumed
step is reported as a question.

The verifier also audits clears. Re-read every cleared lead whose deciding
line is in another module, rests on ordering or initialization, or uses a
reason close to one in [the list below](#the-lead-ledger), and reopen it when
the cited line does not block the sequence. Most missed bugs are leads that
were found and then cleared.

For a consequential finding, go further when the user asks or the cost of a
miss is high (payments, sync, migrations, job queues, auth): build a small
model of the sequence, check it with [Check invariants](../SKILL.md#check-invariants),
and replay the counterexample as a test against the real code.

## The lead ledger

A lead is a state value, exit, or event that the diff or the search touched.
Every lead ends as one of:

- **Finding:** with the evidence above.
- **Cleared:** with the sequence you tried and the `path:line` that blocks
  it, such as the `finally` that resets the flag or the request-id comparison
  after the `await`. A clear needs the same rigor as a finding: you read the
  blocking line yourself.
- **Question:** when the lead has a concrete sequence but one step rests on
  code you did not read or behavior you could not confirm (another module, a
  dependency, an ordering, a delivery guarantee). Report it with the sequence
  and name the unconfirmed step. Do not clear a lead on reasoning you could not
  confirm with a line you read.
- **Not checked:** with the reason, such as source unavailable.

Never return "nothing found" without the ledger. After closing a lead, re-read
its site once for a second, independent problem; two bugs at one site are
common, and the first one found tends to hide the second. Report two bugs at
one site separately when their sequences or consequences differ; do not fold
one into the other's finding.

These are not reasons to clear a lead:

- Another path re-derives the value. Clear only when the cited re-derivation
  runs before every read that matters.
- It is a local copy. Clear only when the copy is not shared, aliased,
  captured by a closure that outlives the call, or written back.
- The UI prevents it. A disabled control does not guard the handler.
- The timing is unlikely. Networks, retries, and users produce the timing.
- A test covers it. Clear only when the test exercises the same sequence.
- Only one caller in this repository. An exported function, library API,
  handler, or job is reachable from callers the repository does not show, from
  retries, and from a second instance.
- It is cosmetic or minor. A wrong count, label, or progress total is a finding
  with a low consequence, not a cleared lead.
- A retry recovers. Clear only after tracing the retry and showing that every
  effect (hooks, notifications, cleanup) runs again.
- Reload or restart re-derives it. Clear only when the re-derivation covers
  every value involved and the wrong value is never read before it runs.
- Initialization order makes it safe. Trace startup, import, and recovery
  paths before relying on an order.
- The callee handles it. Open the callee, including vendored and dependency
  source, before relying on what it does; an `assert`, a registration slot, or
  an error path that returns without setting an error decides the outcome.
