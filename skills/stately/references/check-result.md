# Structured checker result v1

`../scripts/check-result.mjs` owns validation, exact-byte freshness checks, and
conversion to native XGraph. This is a renderer-independent handoff, not a
statechart execution format. Producers must use `parseCheckResult` before
writing JSON; consumers must validate after reading. Unknown versions fail.

| Field             | Contract                                                                                                                                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schemaVersion     | `stately.check-result.v1`                                                                                                                                                                                                                                                                    |
| kind              | `explored-configurations` or `summary-only` (empty state/edge/path arrays); never an authored executable model                                                                                                                                                                               |
| binding.artifacts | `{ role, path, content, sha256 }[]`; original UTF-8 bytes, lowercase SHA-256. Roles: spec, config, model, view, scope, trace, dot. Paths unique. Retain all semantic dependency modules as additional spec artifacts; owned runs bind the SANY loaded local closure.                         |
| checker           | `{ name, version, command: string[], complete, bounds: object, assumptions: string[] }`; include constants, constraints, action constraints, symmetry/VIEW, worker/rerun limits, and errors when applicable. Commands are provenance, never executed on import.                              |
| rules             | `{ id, kind, name, outcome }[]`; kind invariant/property/deadlock; outcome holds/broken/not-checked. Never infer holds from absent marks.                                                                                                                                                    |
| states            | `{ id, variables, initial, violations: ruleId[] }[]`; stable producer raw IDs and original JSON/tagged values. Fingerprints are strings, not JS numbers. Boundary states may carry `{ past, excluded }`.                                                                                     |
| transitions       | `{ id, from, to, action, label? }[]`; stable raw endpoints and action identity, distinct from a human label.                                                                                                                                                                                 |
| counterexamples   | `{ id, ruleId, states: rawId[], transitions: stepId[], loopStart?, stutters? }[]`; first state initial; consecutive edges must match. Loop index is zero based. Explicit closing steps may repeat a state; stuttering may instead identify the last state as loopStart with stutters true.   |
| projection        | Optional `{ regions, notes, ... }`; each region has `{ id, name, states }`. Each projected state has `{ id, path: string[], members: rawId[], marks }`; marks are `{ ruleId, kind: breaks/mayBreak }`. Resolved arrow conditions and hidden-step notes can be retained as additional fields. |

Additional producer metadata is retained, not interpreted as executable code.
Changing field meaning requires a new schema version. Paths/loop indices always
refer to raw configurations, even when a projection merges or hides them.
Retain the original source/report as well; serializing a finite explored graph
cannot reconstruct arbitrary TLA+ or prove application equivalence.

## Optional pstack producer

Use `../scripts/pstack-result.mjs` as a small upstream integration candidate.
Its `exportPstackResult` takes the **already computed** `result`, `walked`,
`chart`, and `found` values from `scripts/pipeline.ts`, plus exact `artifacts`
and `checker` provenance. `result` is pstack's CheckResult, `walked` its Walk,
`chart` its resolved Chart (or undefined), and `found` its sorted Bug array.
It preserves tagged TLA+ values, raw IDs, rule outcomes, bounds, raw-to-projected
membership, marks, conditions, counterexamples and loops.

A producer can add this after projection, independently of Mermaid rendering:

```js
const handoff = exportPstackResult({
  result,
  walked,
  chart,
  found,
  artifacts, // artifact(role, relativePath, exactContent) for spec/config/view/dependencies
  checker: {
    name: 'TLC',
    version: actualTlcVersion,
    command: actualCommand,
    bounds: actualConstantsAndConstraints,
    assumptions: reviewedAssumptions,
  },
});
files.set('check-result.json', [JSON.stringify(handoff, null, 2)]);
```

This is an optional upstream seam, not a patched or forked `/statechart`.
Do not rerun view callbacks: stateful/expensive callbacks could change the
projection. Do not reconstruct membership or verdicts from Mermaid/prose.
Keep TLC flags, checking, exit codes, report, and Mermaid output unchanged.
The included live evaluation checks the installed pstack seam with TLC and
asserts no extra view callbacks or changed Mermaid text. Upstream distribution
and adoption are separate steps.

## Native reports and freshness

The owned runner produces this full standalone result plus a bounded native
XGraph carrying `@statelyai.checkReport` (`stately.check-report.v1`). The native
report schema is defined in `packages/api-contract/src/check-result.ts`:
run/status/checker, per-rule outcomes, raw-variable trace frames and native
entity mappings, artifact hashes, intentionally shared visible documents,
view digest, authoritative recheck inputs with an explicit original source-file map, and separate application checks. The reviewed scope file supplies domain bounds, assumptions, and rule descriptions.
The browser shows it in Checks; the same generated documents also appear in
Documents. An included trace need not map every raw state into the projection;
empty mappings are explicit, and invalid entity references are rejected.

```sh
sh SKILL_DIR/scripts/stately-check graph check-result.json checked.graph.json
```

Read the file and pass the object to
`save_stately_check_result({name:'Checked behavior',graph,context})`. To replace
an existing run, first read `get_stately_check_result({machineId})` and supply
that machineId/revision. Optimistic store writes preserve newer edits.

The full result retains original source/trace bytes locally. Ordinary saved
metadata contains identities/hashes, outcomes, viewed variables and native
bindings; it does not silently embed original source files. The owned check
command's explicit `--share-documents` adds selected generated spec/config/view
and report documents visibly. Application `--source` and unrequested peer TLA
contents remain local. Linked documents must match their bound exact SHA-256.

The legacy raw-configuration converter budgets 180000 characters. The owned
native projection/report budgets 195000, below the 200000 editor limit. Complete
artifacts are always retained; explicit `view --trace` slicing discloses omitted
paths and preserves original verdicts, run ID/time and full-result reference.
A successful large check may have only a summary view. Unsupported oversize
witnesses fall back to complete local Markdown/JSON; no invented configuration
is used to make an empty chart appear executable.

`serializeCheckView` is shared by API/editor and the generated portable helper.
It excludes layout geometry/colors/styles, report attachments, server provenance,
null/empty defaults and exactly empty auto-generated event schemas. Explicit
schemas, nonempty payload schemas, unknown metadata, labels, guards/actions and
other semantic fields remain bound. Real producer→normalize→flowStore startup
and live-browser tests cover this boundary.

The editor recomputes the semantic view digest: edits mark the run historical,
while layout changes remain current. `get_stately_check_result` separately
compares host-supplied source hashes; missing bytes stay unknown. A save/read
success does not establish current source. Legacy module APIs
`graphCheckFreshness(graph,currentArtifacts)` and `resultFreshness` compare exact
bytes, including the full result reference where present.

Recheck sends a coding-host request, preserving an immutable edited proposal.
It does not execute shell strings in metadata or turn graph edits into a proof.
The host resolves trusted workspace inputs, reconciles edits, reruns checks and
application tests, then saves with the current revision. Keep the original
native model separate from a synthetic explored/projection view.
