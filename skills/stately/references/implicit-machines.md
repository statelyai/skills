# Find implicit state machines

Use this when the request starts with application code rather than a known
model. An implicit machine is behavior whose current phase and permitted next
events are encoded indirectly. A single boolean can be enough; a collection of
flags is not automatically one machine. The test is whether an event's valid
outcome depends on a persistent phase or combination of values.

For a diff, branch, or pull request, follow [state-review.md](state-review.md)
instead; it reviews only what the change touches.

## Trace candidates

1. Bound the search: repository, product surface, entry points, and excluded
   generated/vendor code. Read existing tests and user-facing contracts. Search
   for status enums, related booleans, reducers, event handlers, promises,
   timers, retries, subscriptions, cancellation, persistence, and handoffs
   between UI, API, worker, or database. Follow writes and reads across files
   and into owning dependency source when it decides a transition. If that
   public source is not local, fetch it into task-owned scratch space. Record
   its revision. Keyword matches alone are insufficient.
2. For each candidate, record the state-bearing values and owners; the initial
   condition; events and external outcomes; guards; effects; terminal and
   recovery paths. Trace at least one normal path and one failure/cancellation
   path through source. Note where code or tests support each edge and where
   behavior is inferred. Separate independently changing concerns into regions
   or separate machines instead of multiplying unrelated booleans into a false
   Cartesian product.
3. Check each candidate against the kinds in
   [state-bugs.md](state-bugs.md#kinds) and run its parity checks from
   [Find absences](state-bugs.md#find-absences): every exit of a handler that
   sets a busy value, every sibling writer of the same value, every new case.
   Frame each risk as a question or candidate rule until it has the evidence
   in [Evidence for a finding](state-bugs.md#evidence-for-a-finding) and has
   been re-traced in code.
4. Rank as described in [Rank candidates](#rank-candidates). Trace the top
   candidate through its owning code and related tests before stopping. If
   the user asks for bugs or verification, run one bounded check and attempt
   to replay an actionable failure. Report the search boundary and remaining
   gaps; never imply exhaustive coverage from a partial scan.

## Cover the whole scope

The number of candidates follows from the code, not from a target. A first
pass tends to stop near eight candidates whatever the repository size, which
leaves most of a large codebase unexamined. When the request is to find the
machines in an app, or all of them:

1. Inventory first. List the source areas in scope (packages, features,
   providers, platforms, services) with rough file counts before reading any
   of them in depth. This list is the coverage record.
2. Sweep every area, one at a time. In each, search for the signals below,
   open the files with hits, and record candidates before moving on. Do not
   spend the whole budget on the first dense area. Sibling implementations
   (one class per provider, platform, or backend) each hold their own copy of
   a lifecycle; inspect each instead of sampling one.
3. Where the host can delegate, give each area to a subagent with the same
   instructions and merge the results. Otherwise continue area by area.
4. Report every candidate. Give the full ranked table, then detail and
   diagrams for the most consequential ones. A low-risk candidate still
   belongs in the table; mark it low instead of dropping it. Each row needs
   only the name, source location, state-bearing values, risk, and one line
   on the possible conflict, so hundreds of rows fit in one answer. A
   candidate found by a subagent stays in the merged table unless it
   duplicates another row with the same owner and values. Diagram or link
   capacity never limits the table: a candidate without a diagram keeps its
   row, marked not visualized. Do not move found candidates into an unranked
   list of names.
5. If the scope cannot be finished, say which areas were swept, which were
   searched by keyword only, and which were not opened, and offer to continue
   with the named remaining areas. Then the answer is partial coverage, and
   the summary says so before the findings.

Signals that mark state, beyond status enums and booleans:

- Nullable or optional handles where absence means a phase: a task, timer,
  controller, process, connection, lease, or promise that is `null` when idle.
- Nested optionals and sentinel values (`Option<Option<T>>`, `undefined`
  versus `null`, `-1`, empty string) that distinguish "not looked up" from
  "looked up, absent".
- Generation, epoch, revision, token, or sequence counters compared after an
  `await` or callback, and the places that should compare them but do not.
- Sets and maps of ids named for a phase (`pending`, `deleting`, `inFlight`,
  `suppressed`), and atomics or integer constants used as a state code.
- Two or more fields that are always written together, or a derived getter
  that folds several fields into one phase.
- Disposal and shutdown flags (`disposed`, `stopped`, `closing`, `sealed`)
  and every path that must check them.
- A phase that one module derives and another rebuilds from raw events,
  timestamps, or flags. The two derivations can disagree about when a phase
  starts or ends.
- Phase or status literals compared in presentation code (labels, colors,
  CSS classes, badges) apart from the code that owns the phase.
- Error handlers that only log, swallow, return a default, or hold a TODO
  after a state write, and error branches that differ between siblings.
- Paired operations (`inc`/`dec`, `add`/`remove`, acquire/release,
  subscribe/unsubscribe) whose two sides sit on different paths.

## Rank candidates

Rank once, over the merged table, after every area is swept. Do not order by
area, by discovery order, or by how detailed a finder's note is. Every row
gets a rank; no tier is left grouped by area.

First merge rows that describe one machine: values in the same owner that
track the same entity (several maps or sets keyed by one id, flags written
by the same methods, a start flag and its matching shutdown flag) are one
candidate, and the conflict to look for is an entity in two of them at once.
A merged row lists every state-bearing value it absorbs, so no flag
disappears in a merge.

Then score each candidate on what the source shows:

1. **Encoded phases.** Count the state-bearing values that fold into one
   lifecycle and the combinations that have no meaning. Three flags that
   encode a four-phase lifecycle outrank a lone boolean.
2. **Reach.** Count the modules that read or write the values. An owner that
   other features depend on (process, session, connection, tab or window
   manager, plugin or app lifecycle, persistence, a turn or request
   coordinator) outranks a leaf component. A lone flag read or written
   across many modules scores on reach; do not drop it for having one
   value.
3. **Async exposure.** Awaits, callbacks, timers, or retries between reading
   the phase and acting on it, and start, stop, or dispose paths that can
   interleave.
   Count error paths here too: a `catch` or error callback that runs after
   the phase is set and does not restore it, or that only logs. Most severe
   failures in distributed systems start as a non-fatal error that was
   signalled and then mishandled, so an error path that leaves partial state
   ranks above an extra happy-path await.
4. **Consequence.** Lost or unsaved data, a duplicated effect, a leaked
   process or handle, or work attributed to the wrong owner outranks a
   stale label.

A specific failing path raises a candidate. The lack of one does not lower
it: a first pass rarely traces every interleaving, so a cluster with many
encoded phases, wide reach, and async exposure ranks high with its conflict
stated as a question. A sharp note on a leaf component does not outrank it.

When areas are delegated, have each finder return the four scores (value
count, reader and writer count, async boundaries, consequence) with every
candidate so rows from different areas compare on the same scale. Before
fixing the top of the table, reopen the owner of any candidate that scores
high on the first three but has a thin or inferred note, and rewrite its
conflict line from source.

## Show each candidate

Visualize candidates in rank order, not only the first. Call
`visualize_machine` once per candidate, or `visualize_machines` with up to
20 per call, and put each returned link next to its candidate. Pass a
`workspaceId` only when the previous result reported `persistence` as
`server`; otherwise send each batch as its own call. With more
candidates than one answer can diagram, visualize every high-risk candidate,
then medium-risk ones while the budget lasts. When the table has more than 20
rows, visualize at least the top 40 in batches of 20, each batch a separate
`visualize_machines` call. State how many were
visualized, and offer to visualize the rest by rank or area. Every
visualized candidate keeps its returned link, in the answer or in the
inventory file. Do not drop a returned link to shorten the answer, and do
not visualize more candidates than will be linked. Send the
complete model: keep guards, effects, and failure paths. Do not shrink or
split a model to obtain a link or an image. If a link or image is missing
from a result, say so for that candidate and give its full model as an XState
v6 config the user can import into Stately.

## Keep the inventory

When the host can write files, write one inventory document per sweep in a
task-owned directory and name its path in the answer. It holds the ranked
table and, for each candidate, its link and:

- **States** in the product's words, and the values that encode them.
- **Transitions** as a table: state, event, guard, next state, effects, and the
  `path:line` that decides it.
- **Rules** the candidate must keep, stated apart from what the code does.
- **Reachable invalid states**, including those reached by retries, duplicate
  or late events, and concurrent callers.

On a later sweep, update the same document in place. Mark rows whose source
is gone as `possibly removed` instead of deleting them, and add new rows. When
fixes are proposed, group them into issues by shared owner and shared fix, one
issue per group, and ask before filing any issue.

## Hand off one candidate

Provide a small table with **candidate**, **source evidence**, **observed
states/events**, **possible invalid state or transition**, **kind** (from
[state-bugs.md](state-bugs.md#kinds)), and **confidence**. A possible bug that
has the full evidence (state, event, numbered sequence with `path:line`,
acting line, consequence) and survived a re-trace is a finding; anything less
stays a question.
For the selected candidate, supply a readable statechart and source map.
Use the application's language for labels. Mark a source-derived chart as
**estimated from source** even when its separate formal check passes. Show it
as a Stately model when connected, and as an importable XState v6 config
otherwise. Do not erase guards, effects, hierarchy, or concurrent regions to
make the picture simpler without naming that omission.

If the user asks for bugs or verification, establish what must always hold and
what must eventually happen. When the product contract is unclear, state an
explicit best guess and continue reversible modeling if useful. Check one finite model
with [model-authoring.md](model-authoring.md) and the skill's owned checker.
Report each broken rule with its shortest path, model bounds, and a real test or
reproduction result. A model counterexample is not yet an application bug.

## Make a machine explicit

Report the findings first and change code only when the user asks. Make one
candidate explicit per change, in rank order, and preserve external behavior
unless the user authorizes a change.

1. **Tests first.** Write characterization tests that drive the candidate's
   real entry points and assert what a user or caller observes today. Add one
   regression test per confirmed finding; it fails before the change.
2. **Pick the library.** Use XState v6 (`xstate@6` beta, pinned to the version
   the native checker uses). Use `createFSM` from `xstate/fsm` for a flat
   machine with no hierarchy, parallel regions, or actors, and `setup` or
   `createMachine` from `xstate` otherwise. In v6, every transition is an
   object, as in `on: { GO: { target: 'done' } }`; bare string targets are not
   allowed. When the project already depends on XState v5, write a v5 machine
   instead, following the `xstate-v5` skill when it is installed. When the
   project uses another state library (Redux, Zustand, Pinia, MobX), propose
   XState v6 and ask before switching. Write plain TypeScript (a discriminated
   union and a transition function) only when the user asks. State in the
   change summary that `xstate@6` is a beta.
3. **Replace, do not wrap.** Move every state-bearing value of the candidate
   into the machine, then delete the replaced flags, status fields, and
   derived copies. Keep data that is not phase in context.
4. **Check the real machine.** Write the machine's own config
   (`machine.config`) to `Flow.json` and run
   [Check invariants](../SKILL.md#check-invariants) with the same rules. The
   native checker runs XState v6 semantics, so states and transitions come
   from the code, not from an estimate, and
   [Check a fix](../SKILL.md#check-a-fix) runs on the real machine. Guard and
   action behavior still comes from the rules file; cite each implementation's
   `path:line`. Save the machine to Stately.
5. **Run the whole suite**, then the characterization and regression tests
   again.

```ts
// xstate-version: 6
import { createFSM } from 'xstate/fsm';

// Replaces `isUploading` and the early return that left it set.
export const uploadMachine = createFSM({
  id: 'upload',
  initial: 'idle',
  states: {
    idle: { on: { PICK: { target: 'uploading' } } },
    uploading: {
      on: {
        UPLOADED: { target: 'idle' },
        NO_URL: { target: 'failed' },
      },
    },
    failed: { on: { RETRY: { target: 'uploading' } } },
  },
});
```

Not every candidate needs a machine. Leave a two-phase candidate with one
owner, no async step, and no invalid combination as it is, and say why.

## Prevent new implicit machines

After the first explicit change, offer this snippet for the repository's
AGENTS.md or CLAUDE.md, and add it only when the user agrees:

```md
- Model a lifecycle with more than two phases, or any phase that crosses an
  await, timer, retry, or another owner, as an explicit state machine
  (XState, matching the version this repository uses). Do not add boolean
  flags or status strings that encode the same lifecycle.
```
