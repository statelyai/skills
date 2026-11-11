# Find implicit state machines

Use this when the request starts with application code rather than a known
model. An implicit machine is behavior whose current phase and permitted next
events are encoded indirectly. A single boolean can be enough; a collection of
flags is not automatically one machine. The test is whether an event's valid
outcome depends on a persistent phase or combination of values.

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
3. Look for concrete risks: contradictory flags, an event accepted in the wrong
   phase, duplicate or stale async completion, missing cleanup, unreachable
   recovery, persistence that restores an impossible combination, or a UI that
   disagrees with backend state. Frame each as a question or candidate rule
   until checked against intended behavior and replayed in code.
4. Rank by consequence, likelihood of a reachable conflict, and strength of
   evidence. Trace the top candidate through its owning code and related tests
   before stopping. If the user asks for bugs or verification, run one bounded
   check and attempt to replay an actionable failure. Report the search
   boundary and remaining gaps; never imply exhaustive coverage from a partial
   scan.

## Hand off one candidate

Provide a small table with **candidate**, **source evidence**, **observed
states/events**, **possible invalid state or transition**, and **confidence**.
For the selected candidate, supply a readable statechart and source map.
Use the application's language for labels. Mark a source-derived chart as
**estimated from source** even when its separate formal check passes. Prefer
an interactive Stately model when connected; Mermaid remains the portable
fallback. Do not erase guards, effects, hierarchy, or concurrent regions to
make the picture simpler without naming that omission.

If the user asks for bugs or verification, establish what must always hold and
what must eventually happen. When the product contract is unclear, state an
explicit best guess and continue reversible modeling if useful. Check one finite model
with [model-authoring.md](model-authoring.md) and the skill's owned checker.
Report each broken rule with its shortest path, model bounds, and a real test or
reproduction result. A model counterexample is not yet an application bug.

If the user asks to make a machine explicit, propose the smallest source change
that makes states and transitions clear in the existing framework. A union,
reducer, statechart, or actor may fit; XState is optional. Preserve external
behavior unless the user authorizes a change. Recheck the model and run the
application's existing tests after implementation.
