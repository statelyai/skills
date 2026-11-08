# Owned TLA+ checking

Use this entrypoint for safety invariants, temporal properties, fairness,
deadlocks, constrained models, and multiple rules. Pstack and mise are optional.

```sh
sh SKILL_DIR/scripts/stately-check check Flow.tla --config Flow.cfg --view Flow.view.mjs --scope scope.json --out NEW_RUN_DIR --source src/flow.ts --json
```

On Windows, use `& 'SKILL_DIR/scripts/stately-check.ps1'` with the same
arguments; the examples below use the POSIX shell launcher. No POSIX shell is
required on Windows.

The `check` word may be omitted for `.tla` positional input, including flags
before the specification. `--config`, `--view`, and `--out` preserve the familiar
checker arguments; `--flag=value` and `--` (end of options) are supported.
Omitting `--out` uses `SPEC-chart`, matching the original checker convention.
Without `--json`, `--compact` prints the concise report to stdout while retaining
the complete `report.md` and JSON evidence. The output directory must
be new or empty; existing results are preserved. Repeated `--source` arguments
bind reviewed application source bytes without uploading their contents.

Runtime: Node 22.18–22.x or 23.6+, Bun 1.1.5+, or Deno 2+; the shell launcher
selects an available runtime. Deno uses `--allow-all` so supervision can inspect
protected `/proc` entries without requiring an external `ps`; model/view code
and downloaded-tool execution are trusted, as with Node/Bun. The repository itself requires Node 24. Java 11+
is used when available or configured by `JAVA`; otherwise an official Temurin
25 JRE is provisioned into the user's Stately cache. TLC 1.7.4 is downloaded with
its pinned SHA-256. Downloads use HTTPS and checksum validation. `TLA2TOOLS`
selects another jar; record its actual version/digest and validate compatibility.
`STATELY_TLC_JAVA`/`STATELY_TLC_JAR` are equivalent explicit overrides.
A cold cache prints progress to stderr, for example
`Downloading Temurin JRE 25 (56 MB) into CACHE ...` (the size varies by
platform), `Downloading TLC 1.7.4 (2 MB) ...`, and `Ready`; `render` prints the same for Pele. A warm cache prints nothing, and
stdout stays the report or `--json` object either way.

`--offline` permits only installed/cached tools. `STATELY_CACHE_DIR` selects the
cache. A default 300-second checking limit prevents an unbounded initial run;
`--timeout SECONDS` changes it, and `--timeout 0` disables it for an intentionally
long check (maximum numeric limit 2147483.647 seconds). An unfinished checker certifies no rules. Completed raw checker checkpoints survive later presentation/interruption errors, with preserved original verdicts and an explicitly incomplete native summary. Worker/Java
processes are terminated together; parent death also triggers cleanup.

## Results and projections

- `compact-report.md`: concise chart context, rule outcomes, and failure paths.
- `report.md`: complete human report, each rule's verdict, scope and limits.
- `chart.mmd`: readable Mermaid fallback when a chart exists.
- `tlc.out` and per-rule output: actual checker diagnostics.
- `check-result.json`: complete raw states, transitions, tagged TLA values,
  counterexamples, projection mappings, exact source contents and hashes.
- `check-report.json`: native UI contract with outcomes, variable snapshots,
  witnesses, source bindings, recheck inputs, and separate application evidence.
- `graph.json`: native Stately view carrying the report, when it fits the editor.

Exit codes: 0 no broken rules in the original configured check; 1 a broken rule;
2 failure; 124 timeout; 130/143 interruption. A missing input or a non-empty
`--out` stops before any output is created, with one line on stderr naming the
path. With `--json`, such errors print `{"ok": false, "error": {"code", "message", "path"}}`
to stdout instead (`path` only when one applies). Other subcommands exit 1 with
a one-line message. Always inspect every rule and run
status: a later error/budget can leave some rules not checked. Error reports are
retained rather than described as successful checks.

Checking copies the specification, the local `.tla` modules it reaches through
`EXTENDS` and `INSTANCE` (transitively, ignoring comments and strings), and the
selected config into `inputs/` as `Run.cfg`. Standard modules such as `Naturals`
have no local file and come from TLC. SANY then reports the modules it actually
loaded; only those are bound in the completed result. Unused neighbors are
neither copied nor gate freshness. The selected view executes once in its original module context;
observed view-file changes invalidate publication. Imported JS dependencies,
external effects, and model/application refinement remain explicit assumptions.

Read [model-authoring.md](model-authoring.md) before authoring the model or
view. It covers rule rigor, terminal stutters, human labels, parallel-region
conditions, safe coarsening, and report interpretation. A view may export
`state(vars)` as a string, hierarchy array, or object of regions, with optional
`step(action, from, to)`, `group(vars)`, `colors`, and `title`. Use domain words
rather than TLA+ identifiers. Adapt this example to every actual state/action:

```js
export const title = 'Payment cancellation';
const phases = {
  ready: 'Ready',
  paying: 'Payment pending',
  cancelled: 'Cancelled',
  paid: 'Paid',
};
const actions = {
  StartPayment: 'You start checkout',
  Cancel: 'You cancel checkout',
  ConfirmPayment: 'The provider confirms payment',
  Done: 'Checkout stays finished',
};
export const state = ({ phase }) => phases[phase];
export const step = (action) => actions[action];
```

Resolved projections preserve hierarchy, parallel regions where supported,
conditional arrows, raw membership, and breaks/may-break marks. The engine
checks projection consistency and loops; correlated regions fall back to parent
states. Native diagram events are synthetic navigation, with conditions shown
as annotations. Checks playback uses the exact raw counterexample and variable
snapshots. It does not execute application code.

Above 500 explored configurations, the diagram contains counterexample paths;
with no failures it can be a summary-only native view. Multiple rules continue
to be checked, with bounded reruns marked not checked when exhausted. The
complete raw result/human report remain authoritative about each verdict.

For every `.mmd` chart shown, run the owned `render` command and provide its SVG
and Mermaid text; see [render.md](render.md). A failed image render does not
change a checked verdict. Preserve the Mermaid and report the rendering error.

The saved editor model has a 200000-character budget, including report/docs.
The runner uses a 195000-character budget and never silently drops evidence.
If needed, create an explicit failure slice from the full result:

```sh
sh SKILL_DIR/scripts/stately-check view RUN_DIR/check-result.json --trace counterexample_0 --out selected.graph.json
```

Repeat `--trace` to include more paths. This retains every original rule verdict,
source binding, run ID/time, full-result reference and explicit omitted path IDs.
Rendering an existing run does not execute a new check. A single oversize witness
can still require the complete local Markdown/JSON artifacts.

`--share-documents` deliberately includes only the selected spec, config, view,
reviewed scope, and human report as visible generated documents. Neighboring TLA modules and
application `--source` contents are not automatically uploaded. Without this
flag, saved metadata contains artifact identities/digests rather than source
file bodies. The complete local result always retains the originals.

## Reviewed scope and application evidence

Provide a task-owned `scope.json` when modeling source/requirements. It records
reviewed assumptions instead of inferring them from comments:

```json
{
  "bounds": { "phases": 4, "cancelled": "boolean" },
  "assumptions": ["Payment callbacks may arrive after cancellation."],
  "ruleDescriptions": {
    "invariant:CancelledNeverCharged": "A cancelled checkout cannot charge."
  }
}
```

Run with `--scope scope.json`. Scope is an exact-byte bound input, visible in
both human and native reports. `report.md` includes actual toolchain identity,
configured sections/constants/constraints, counts and resource bounds,
reviewed assumptions, rule outcomes and proof/application limits, even when
there is no chart. State-level `PROPERTY` predicates are identified as initial
checks; use `INVARIANT` or temporal formulas for throughout-behavior obligations.

After running the real application's tests/reproduction, write actual
observations to a separate file:

```json
[
  {
    "name": "Late callback regression",
    "status": "passed",
    "summary": "The existing application's regression test passed.",
    "source": "src/payment.test.ts; pnpm test --run src/payment.test.ts"
  }
]
```

Status is `passed`, `failed`, or `not-run`; name/summary are required and source
is an optional citation. This records host observations; it does not execute or
attest a test. Never copy this example as a claimed test run.

```sh
sh SKILL_DIR/scripts/stately-check record-app-checks RUN_DIR/graph.json actual-checks.json checked-with-app.graph.json
sh SKILL_DIR/scripts/stately-check freshness RUN_DIR/check-result.json --workspace CURRENT_PROJECT
```

The attachment command preserves the existing view seal and rejects edited or
unbound graphs; it never reseals an edit. Save the new graph object. Original
checker artifacts remain unchanged. Keep complete test output locally and cite
it. Model playback and application tests stay distinct.

`freshness` resolves `recheck.sourceFiles` inside the chosen physical workspace
using that workspace as the base for relative source paths, and emits ready-to-use `currentArtifacts` for `get_stately_check_result`. Select the equivalent project root to compare a moved or second checkout; the recorded original working directory remains provenance. Missing
files are stale; absent mappings remain unknown. It rejects traversal and
symlink escapes instead of following paths into another checkout. The explicit workspace argument selects both the coordinate root and permitted reads. Never broaden
the workspace just to satisfy a saved path. Compared hashes describe that point
in time, not ongoing file watching. Artifact aliases such as `inputs/Run.cfg`
and `source/src/flow.ts` map to their actual original source paths explicitly.

`check-result.raw.json` and `raw-report.md` are written before projection code.
If presentation is interrupted, existing completed proof files are preserved;
returned paths may use `interrupted-*` diagnostic filenames. The summary lists
preserved verdicts and points to the complete raw paths instead of inventing
native mappings. After the janitor starts, abrupt parent death removes unfinished staging; completed
checkpoints recover to `OUT_DIR.recovered-<id>`. These files do not imply a
successful host delivery or application replay.

## Import an existing result

This imports a TLC JSON trace (`-dumpTrace json`) or DiskGraph DOT dump
(`-dump dot`). Plain TLC text output such as `tlc.out` is not parsed, and no
command reads an installed pstack plugin; for a pstack Mermaid chart, see
[render.md](render.md) and [statechart-handoff.md](statechart-handoff.md).
Run the launcher with original sources, checker provenance, and a new output
filename:

```sh
sh SKILL_DIR/scripts/stately-check import-trace trace.json Checkout.tla Checkout.cfg provenance.json check-result.json
sh SKILL_DIR/scripts/stately-check graph check-result.json checked.xgraph.json
```

`import-dot` takes the same arguments, with a TLC DOT dump as its first input.
Example provenance (replace every value with the actual run):

```json
{
  "version": "actual TLC version and revision",
  "command": [
    "java",
    "-jar",
    "tla2tools.jar",
    "-dumpTrace",
    "json",
    "trace.json",
    "Checkout.tla"
  ],
  "bounds": { "constants": "exact constants/constraints from this run" },
  "assumptions": ["reviewed model assumptions and omissions"],
  "rule": { "kind": "invariant", "name": "CancelledNeverCharged" }
}
```

Trace JSON lacks the violated rule's identity; supply it from the original TLC
result. Trace import understands TLC's `counterexample.state`/`action` tuples,
including a closing loop edge or stuttering step. Legacy JSON arrays and unknown
formats fail explicitly. A trace contains one counterexample, not proof that
other rules hold. Exploration completeness is unknown.

DOT import understands standard TLC `DiskGraph` output from `-dump dot` or
`-dump dot,actionlabels`. It preserves fingerprint IDs as strings and TLA+
variable labels as text. It does not parse arbitrary Graphviz or infer rule
verdicts/completeness. Dumping after an error may yield only part of the graph.

The helpers retain the exact trace/DOT, `.tla`, and `.cfg` text and hashes.
For imported modules or a view, also retain every dependency with
`artifact('spec'/'view', path, exactContent)` when using the module API; the
minimal CLI binds only its three supplied files. Without the full dependency
closure, report source freshness as incomplete. Neither format imports an
editable specification or supports lossless TLA+ round-tripping.

Use the native save tool with the resulting XGraph. Read import notes; retain
the original report, check result JSON, and IDs. Check exact-byte freshness
before presenting historical evidence as current; see [the result contract](check-result.md).

## Export a narrowly supported native model

Export only a single flat machine with deterministic external-event transitions,
one initial child, and optional final children without outgoing edges. Native
v5/v6 correspondence is tested for this subset. Supported invariants forbid
explicit leaf state IDs. Supply finite limits (graph size limits, not search
truncation) in an options file:

```json
{
  "module": "StatelyCheckout",
  "bounds": { "maxStates": 50, "maxTransitions": 200 },
  "invariants": [
    {
      "name": "CancelledNeverCharged",
      "forbiddenStateIds": ["chargedAfterCancellation"]
    }
  ]
}
```

```sh
sh SKILL_DIR/scripts/stately-check export authored.xgraph.json options.json new-check
cd new-check
java -jar /path/to/tla2tools.jar -workers 1 -dump dot,actionlabels explored.dot StatelyCheckout.tla
```

Module names start with `Stately`; invariant and transition TLA identifiers are
stable generated IDs. The output contains `.tla`, `.cfg`, and `manifest.json`
with exact model/spec/config digests, bounds, assumptions, event/entity mapping,
and invariant mapping. Keep that manifest with checking results. The exporter does not run TLC or assert a verdict. Run the owned `check` command against its generated spec/config; a DOT alone cannot supply a verdict.

Rejected: arbitrary JS or implementations, context/payload schemas, guards,
actions, eventless/ordered branches, wildcards, timers, actors/internal events,
reentry flags, hierarchy/parallel/history, unknown execution fields/profiles,
semantic SCXML descriptor metadata, and imported configuration views. Preserve unsupported native models rather
than deleting semantic fields to force export. Known empty editor defaults and
presentation metadata are accepted. IDs must be printable ASCII; labels can
retain reader-facing text. The input remains an authored native XGraph, never
the checked configuration view.

Semantics: one external event per atomic step; any event can occur next;
unhandled events stutter. No queue, scheduler, fairness, liveness, or application
implementation equivalence is asserted. `CHECK_DEADLOCK FALSE` allows terminal
states; do not report a NoDeadlock proof. `TypeOK` checks membership in the finite
control-state set. An invariant about memory/data requires an explicit supported
control-state representation or a separately authored TLA+ spec; it cannot be
inferred from labels.

The bounded checkout evaluation reproduces the existing three-event late-confirmation
bug and checks the corrected transition. It compares the native v5/v6 transition
relation and ignored-event behavior with the export, then runs actual TLC against
buggy/fixed exports and compares the reachable DOT relation with the native
mapping. This is evidence for that finite subset and fixture, not a general
statechart-to-TLA+ equivalence proof.
