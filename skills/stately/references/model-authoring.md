# Model, project, and explain behavior

Use this reference with the owned checker and native Checks workflow. It carries
forward the modeling and presentation discipline of Lauren Tan's MIT-licensed
`statechart` skill; see [attribution and license](../scripts/engine/NOTICE.md).
No pstack installation is required.

## Discover and model the actual behavior

Start with the requested behavior, its source entrypoints, contracts, tests, and
existing specifications/configurations/views. Reuse a relevant model instead of
inventing a second account of the system. For a new model, keep generated files
in a task-owned artifact directory. Preserve the application's framework.

The model describes implementation behavior; rules state what should hold. Add
an explicit model variable when an agreed rule needs information the current
model omits. Never weaken an accepted rule to make the checker pass or delete
behavior because it creates a counterexample. Use `INVARIANT` for state safety;
state-level `PROPERTY` alone checks the initial condition. Give temporal progress
properties their actual temporal formula and state any fairness assumption.

When requirements or implementation facts are missing, record reasonable best
guesses as explicit assumption strings in `scope.json`. In the explanation,
distinguish observed, inferred, assumed, and still-unverified facts, why each
assumption is needed, and how it affects the conclusion. Produce a useful bounded
first pass. Ask a focused question only when its answer materially changes
the model or finding; do not invent agreement or demand routine approval.

Define `Next` as a disjunction of named actions, so traces identify the operation
that changed state. A single anonymous `Next` can label every step identically.
Keep constants finite/small or add a reviewed constraint; exploration continues
past bugs and an unbounded model can run indefinitely.

A correct terminal state without a successor still fails TLC's deadlock check.
When staying finished is valid, add a terminal-only stutter and name it in the
view, for example:

```tla
Done == phase \in {"paid", "failed"} /\ UNCHANGED vars
Next == StartPayment \/ Cancel \/ ConfirmPayment \/ Done
```

Use the model's actual variable tuple for `vars`. Never add `Done` in states
where stalling would hide a real deadlock. The implicit rule is `NoDeadlock`, or
`CHECK_DEADLOCK` when an explicit invariant/property already uses `NoDeadlock`.
Disabling deadlock checking is a scope choice, not a deadlock proof.

## Project for the person deciding

Write state names, arrow labels, phases/colors, and the title in the reader's
language. Keep implementation variable names out of display labels. A view's
`state(vars)` can return:

- A string for one flat state, such as `'Payment pending'`.
- An array for hierarchy, such as `['Checkout', 'Payment pending']`.
- An object of parallel regions, such as
  `{ checkout: 'Payment pending', connection: 'Offline' }`.

The view API represents a TLA+ sequence as a 1-indexed object (`v.pc[1]`), and a
TLA+ set as a JavaScript array. Records/functions are objects; do not assume a
TLA+ sequence is a zero-indexed JavaScript array. Distinct TLA+ values can share
a JavaScript-looking representation: choose intentional domain labels.

`step(action, from, to)` names a human operation or observed result, such as
`'You cancel checkout'` or `'The roster read fails'`, rather than a code fragment
or raw action identifier. Give actions with the same visible effect the same
label. When an unshown value decides the outcome, name that outcome explicitly.

For a condition outside the pictured state, end the label with a reader-facing
condition, for example `'You press play [while the file loads]'`. In a regions
chart the engine already adds conditions on other regions, such as
`'[when Offline]'`. Custom brackets replace that automatic condition, so do not
replace a condition on another region with your own brackets; distinct arrows
can otherwise look identical.

`group(vars)` names a phase; `colors` maps phase names to `blue`, `orange`,
`purple`, `yellow`, `teal`, `tan`, or `pink`. A chart state whose underlying model
states belong to different groups receives no group color. `title` is a string.
Callbacks depend only on their arguments: `state()`/`group()` run at most once
per raw state and `step()` at most once per raw transition, with the resolved
answers reused by the chart and report. Avoid mutation, randomness, clock reads,
and external effects in callbacks.

## Simplify without hiding a failure

Aim for about 20 arrows when possible. First coarsen labels for values that act
the same and omit details irrelevant to the reader. Keep every bug-path state
and its marks. Do not merge states that break different rules or turn a precise
`breaks` location into an ambiguous `mayBreak` location merely to simplify.
A step that stays in one visible label has no diagram arrow; split the label
when that operation needs to be visible. Raw traces still retain the step.
When the report counts steps that stay in a chart state, inspect the raw
transitions and projected state membership in `check-result.json` to identify
the operations and changed values. A count alone cannot tell the reader that,
for example, a task changed owners. Split labels and recheck if an omitted
operation matters to the review; name remaining omitted operations in the handoff.

For redundant navigation, `step()` may return `null`, subject to all of these:

- Every chart state stays reachable from an initial state.
- A chart state with outgoing model steps retains at least one outgoing arrow.
- All raw steps of an arrow are hidden together, or none are hidden; hiding only
  some narrows the displayed condition misleadingly.
- The handoff names the hidden operations and omitted behavior.

Use explicit failure slices when native editor limits require them, retaining
all verdicts and disclosing omitted path IDs. Do not silently trim evidence.

## Interpret the report before explaining it

`breaks` means the represented configurations break the marked rule; `mayBreak`
means only some configurations behind the visible state do. The legend maps
marks to rules, including multiple rules on one mark. Say which state breaks
which rule. For regions, marks can depend on combinations of region states;
inspect the full path/variables rather than treating one region as independently
proved unsafe. A repeated-path mark preserves a temporal lasso or stutter.

With `VIEW` or `SYMMETRY`, TLC counts representatives; an arrow can target a
representative rather than the exact raw successor. Read the report's caveat.
Past `CONSTRAINT`/`ACTION_CONSTRAINT` bounds, TLC can still check rules without
exploring that state or checking it for deadlock. A shortest violation witness
can include that state/excluded action, while other beyond-bound states are not
drawn. Do not present bounded absence of deadlock as an unbounded guarantee.

The engine runs the original configuration with one TLC worker. After a rule
breaks it removes that rule and reruns to discover other failures; each rerun
after the first break is bounded at 100,000 distinct states. Budget/error stops
leave affected rules `not-checked`, which can mean holds or breaks. Use a smaller
model or remove known broken rules from the configuration to investigate them.
Rerun bounds can change which temporal witness TLC finds. `tlc.out` describes the
original check; `tlc-RULE.out` supplies separate failure evidence when applicable.

The 500-state diagram budget uses the original configured run's state count.
Above it, Mermaid contains failure paths; with no failures there may be no
`chart.mmd`. The complete report still carries counts, rules, and all witnesses.
Native Checks may provide a summary-only view. Do not invent an image or path.

## Hand off and replay

Use `compact-report.md` to orient the reader; inspect `report.md` and the JSON
for full evidence. Give each available chart as Mermaid text and an SVG from
[render.md](render.md), plus the native Checks link when available. For every
bug, provide the rule, its domain meaning, and the path using the report's step
numbers. Preserve closing loops/stutters, say what the model omits and what the
chart hides, and give the command with a fresh `--out` directory.

For code models, replay each action against the real application through its
existing tests or a live reproduction. Check observable effects, not just model
positions. If the path fails to reproduce, first suspect the model or its mapping
to real operations; investigate before claiming an application defect. Record
actual passed/failed checks separately from formal results, or `not-run` with a
reason. A diagram playback does not execute the application.
