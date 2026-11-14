# Owned TLA+ checking

The default checker runs on the native statechart and a rules file; see
[native-checking.md](native-checking.md). Use this TLA+ path when the user
supplies a `.tla` or asks for TLA+, or when the model needs set- or
function-valued state, model-value constants, symmetry, strong fairness,
general temporal formulas, or unbounded data. It covers safety invariants,
temporal properties, fairness, deadlocks, constrained models, and multiple
rules. Pstack and mise are optional.

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
export const title = "Payment cancellation";
const phases = {
  ready: "Ready",
  paying: "Payment pending",
  cancelled: "Cancelled",
  paid: "Paid",
};
const actions = {
  StartPayment: "You start checkout",
  Cancel: "You cancel checkout",
  ConfirmPayment: "The provider confirms payment",
  Done: "Checkout stays finished",
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
  "command": ["java", "-jar", "tla2tools.jar", "-dumpTrace", "json", "trace.json", "Checkout.tla"],
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

## Export a native model

`stately-check export` turns the native checker's two inputs (a model in XGraph or
XState config form and a rules file) into a TLA+ module and a TLC configuration, so
TLC can check the same model and the same rules. The native checker stays the
default; use the export when a TLC run is wanted as independent evidence or for
a check the native engine does not provide.

```sh
sh SKILL_DIR/scripts/stately-check export model.json rules.json new-export --module Checkout
sh SKILL_DIR/scripts/stately-check check new-export/Checkout.tla --config new-export/Checkout.cfg --manifest new-export/manifest.json --out new-run --json
```

The output directory holds `<module>.tla`, `<module>.cfg`, and `manifest.json`.
The manifest maps every rule of the rules file to its TLA+ name and kind. Pass it
to `check` as `--manifest`: the run then also writes `native-rules.json` and
reports `nativeRules` in the JSON output, one entry per rule of the rules file
with its native id, its TLC id, the outcome, and the length of a counterexample
or witness. The check result itself keeps the TLC rule ids.

Encoding: `conf` is the set of active atomic state ids and each context field is
a variable bounded by the declared domain (`CONSTRAINT InDomain`). An event is
one TLA+ action that applies the selected transitions, then eventless
transitions and state completion events until nothing more is enabled. Guards,
assignments, entry and exit actions, payload fields, and `in()` translate from
the rules expression grammar. Rule kinds map as follows:

| Rule kind                               | TLC                                                                                        |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| never                                   | INVARIANT                                                                                  |
| reachable                               | INVARIANT on the negation; the TLC verdict is inverted and a counterexample is the witness |
| initially                               | PROPERTY on a state predicate (initial states only)                                        |
| eventually, eventually-always, leads-to | temporal PROPERTY                                                                          |
| no-dead-ends                            | CHECK_DEADLOCK TRUE; `allowFinal` adds a stuttering `Done` action                          |

Fairness `weak` becomes `WF_vars(Next)`; a per-event list adds `WF_vars(E_<event>)`
for each listed event; `none` adds no fairness.

Rejected, with the reason in the error: a guard or assignment without an
expression, history and choice states, `event.*` outside a handler whose event
declares that payload field, truthiness or mixed-type comparisons, real numbers,
more than one no-dead-ends rule, and transitions in different parallel regions
that can fire together with overlapping exit sets. Preserve the model instead of
deleting semantic fields to force an export; the native checker can still check
it.

Known differences from the native checker, each documented rather than hidden:
a liveness counterexample may list a different successor at the boundary of the
explored states; a self-transition under per-event fairness is a real step for
TLC but a repeat of the same state for the native checker; when two regions fire
on one event, TLC runs their actions in document order of the regions, which the
native checker also does, but action order across regions is not asserted by
any rule.

The `native-tla.test.mjs` suite under `evals/native-check` runs the native checker
and TLC on the same fixtures and requires identical verdicts and identical
counterexample lengths. The corpus measurement script `native-tla-measure.mjs`
does the same for every corpus case.
