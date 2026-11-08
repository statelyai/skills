# Import existing statechart/TLC evidence

New checks belong to `/stately` and its packaged checker. An existing pstack
`/statechart` run remains usable: retain its original `.tla`, `.cfg`, view,
report, raw TLC output, counterexamples, assumptions, and bounds. Importing a
historical result does not rerun its checker.

Prefer an existing `stately.check-result.v1` file:

```sh
sh SKILL_DIR/scripts/stately-check graph check-result.json checked.graph.json
```

Save the graph using `save_stately_check_result`. The optional
`pstack-result.mjs` adapter accepts already-computed pstack CheckResult/Walk/Chart
values. It preserves tagged values, raw IDs, rule outcomes, membership, marks,
conditions, counterexamples and loops. It never executes view callbacks again
or reconstructs verdicts from Mermaid prose. No patch to an installed pstack
skill is required for Stately's own checking workflow.

For raw TLC trace/DOT, use the explicit provenance imports documented in
[formal-checking.md](formal-checking.md). A trace establishes only its stated
failure; a DOT establishes no rule verdict or exploration completeness.

If only Mermaid/report exist, use
`visualize_machine({format:"mermaid",machine:chartText})`, read warnings, and
compare states and paths with the original report. Keep historical evidence
separate from a newly executed check. Presentation legends must be explicit
notes in a handoff copy; do not infer a legend from a domain state's name or
shape. The owned Stately producer supplies its native report/marks directly.

A projected graph can merge raw configurations or display conditional regions.
Keep raw paths/variables available, and keep an authored native specification
separate from an explored view. Replay actionable failures in the existing
application. Reconcile intended edits with its authoritative spec/source before
running a new owned check; do not silently reverse-compile a projection.
