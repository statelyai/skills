# Import existing statechart/TLC evidence

New checks belong to `/stately` and its packaged checker. An existing pstack
`/statechart` run remains usable: retain its original `.tla`, `.cfg`, view,
report, raw TLC output, counterexamples, assumptions, and bounds. Importing a
historical result does not rerun its checker.

What each existing artifact supports:

| Existing artifact                            | Supported path                                                   |
| -------------------------------------------- | ---------------------------------------------------------------- |
| Stately `stately.check-result.v1` JSON       | `graph` builds a native view (below)                             |
| TLC JSON trace (`-dumpTrace json`, TLC 1.8+) | `import-trace` with explicit provenance                          |
| TLC DiskGraph DOT (`-dump dot`)              | `import-dot` with explicit provenance; no rule verdict           |
| Computed pstack CheckResult/Walk/Chart       | `pstack-result.mjs` module adapter (below)                       |
| pstack `chart.mmd` Mermaid chart             | `render` draws an SVG; `visualize_machine` gives a lossy diagram |
| pstack report text and `tlc.out` logs        | Not parsed; keep them as cited evidence beside any import        |

Nothing reads an installed pstack plugin. Each import keeps the supplied files'
exact text and hashes as provenance.

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

For a TLC JSON trace or DOT dump, use the explicit provenance imports
`import-trace` / `import-dot` documented in [formal-checking.md](formal-checking.md).
A trace establishes only its stated failure; a DOT establishes no rule verdict
or exploration completeness. pstack's pinned TLC 1.7.4 cannot write
`-dumpTrace json`; rerun TLC 1.8+ for a trace, or check anew with `/stately`.

If only Mermaid/report exist, render the chart with
`sh SKILL_DIR/scripts/stately-check render chart.mmd` and, for a native diagram,
use `visualize_machine({format:"mermaid",machine:chartText})`. Both are lossy:
they carry no verdicts, variables, or raw paths. Read warnings and compare
states and paths with the original report. Keep historical evidence
separate from a newly executed check. Presentation legends must be explicit
notes in a handoff copy; do not infer a legend from a domain state's name or
shape. The owned Stately producer supplies its native report/marks directly.

A projected graph can merge raw configurations or display conditional regions.
Keep raw paths/variables available, and keep an authored native specification
separate from an explored view. Replay actionable failures in the existing
application. Reconcile intended edits with its authoritative spec/source before
running a new owned check; do not silently reverse-compile a projection.
