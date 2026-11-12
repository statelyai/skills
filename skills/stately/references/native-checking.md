# Native checking

`/stately check` checks a statechart directly by default. The native checker
explores every reachable configuration of the model under XState v6 semantics
and checks each rule in a rules file. It needs no Java and no TLA+.
Use [formal-checking.md](formal-checking.md) only for the cases listed in
[When to use TLA+ instead](#when-to-use-tla-instead).

```sh
sh SKILL_DIR/scripts/stately-check check Flow.json --rules Flow.rules.json --out NEW_RUN_DIR --json
```

On Windows, pass the same arguments to `& 'SKILL_DIR/scripts/stately-check.ps1'`.

Options:

- `--rules FILE`: the rules file. Defaults to `Flow.rules.json` beside the model
  when that file exists.
- `--scope scope.json`: reviewed bounds, assumptions, and `ruleDescriptions`,
  in the same format as the TLA+ path.
- `--source path/to/flow.ts`: binds reviewed application source bytes to the
  result without uploading them. Repeat for each file.
- `--offline`: use only cached dependencies.
- `--share-documents`: also share the model file and `report.md` with the
  saved result. The rules file and scope file are always attached as
  documents, since they contain no application source. Application source is
  never shared.
- `--compact`: without `--json`, print the concise report to stdout.

The first run downloads XState 6.0.0-alpha.65 (about 0.4 MB, checksum-verified)
into the Stately cache. Later runs reuse it.

## Model input

`Flow.json` is one of:

- A native XGraph with `nodes` and `edges`: the `graph` returned by
  `open_stately_editor` or `get_stately_machine`, or a model saved with
  `save_stately_models`.
- An XState v5 machine config with `states`, `initial`, `on`, `always`,
  `after`, `onDone`, and `invoke.onDone`.

In XGraph, entry, exit, and transition actions must be arrays of objects with a
non-empty `type`, such as `[{ "type": "markSaved" }]`. A malformed action list
stops checking before exploration.

## What the checker covers

- Statechart semantics come from XState v6 pure transition functions:
  hierarchy, parallel regions, exit and entry order, `reenter`, targetless
  transitions, eventless (`always`) transitions, `onDone` completion, and
  multi-target transitions. An eventless loop that never settles is an error.
- Every event type on any edge may occur in any state. Unhandled events are
  ignored. Delays (`after`), actor done, and actor error are treated as
  nondeterministic events. State completion events are raised internally and
  are not part of the external event set.
- Context is bounded. Each context variable used by a rule, guard, or action
  has a finite domain in the rules file.
- Event payloads are finite lists in the rules file. Guards and actions read
  them as `event.field`.

## Rules file

```json
{
  "context": { "tries": { "min": 0, "max": 3 }, "locked": "bool", "status": ["a", "b"] },
  "init": [{ "tries": 0 }, { "tries": 2 }],
  "guards": { "canRetry": "tries < 3" },
  "actions": { "bump": { "tries": "tries < 3 ? tries + 1 : tries" } },
  "events": { "ADD": { "payloads": [{ "n": 1 }, { "n": 3 }] } },
  "fairness": { "weak": ["RETRY"] },
  "rules": [
    { "id": "StartsUnlocked", "kind": "initially", "then": "!in('lockedOut')" },
    { "id": "NoLockedSignIn", "kind": "never", "when": "in('signedIn') && in('lockedOut')" }
  ],
  "bounds": { "maxStates": 50000, "timeoutMs": 0 },
  "assumptions": ["Free text carried into the report."]
}
```

Unknown top-level keys are rejected. Every key except `rules` is optional.

| Key | Value |
| --- | --- |
| `context` | Domain per variable: `{ "min": int, "max": int }`, `"bool"`, or a list of values. |
| `init` | Initial context, as one object or a list of objects. A list gives several initial states. |
| `guards` | Guard name to boolean expression. |
| `actions` | Action name to `{ variable: expression }`. Every assigned variable needs a domain. All right-hand sides read the state before the step. |
| `events` | Event type to `{ "payloads": [ {...}, ... ] }`. Each payload is a separate event. |
| `fairness` | `"weak"` (default), `"none"`, or `{ "weak": [eventTypes] }`. |
| `rules` | Non-empty list of rules with unique `id` values. Each rule may carry a `description`. |
| `bounds` | `maxStates` (default 50000), `timeoutMs` (default 0, which disables the wall-clock cap), and `maxAlwaysSteps` (default 50). |
| `assumptions` | Strings copied into the report. |

When exploration stops early at a bound, every rule is `not-checked` and the
reason is in `checker.bounds.incompleteReason`.

A context domain acts as a constraint. A state whose context falls outside
its domain is kept and checked against every rule, but is not explored further.

### Rule kinds

| Kind | Fields | Meaning |
| --- | --- | --- |
| `never` | `when` | No reachable state satisfies `when`. |
| `initially` | `then` | Every initial state satisfies `then`. |
| `eventually` | `then` | Every behavior reaches a state where `then` holds. |
| `eventually-always` | `then` | Every behavior reaches a point after which `then` always holds. |
| `leads-to` | `when`, `then` | Every state satisfying `when` is followed by a state satisfying `then`. |
| `no-dead-ends` | `allowFinal` (default `true`) | Every reachable state has an outgoing step. Final states are allowed unless `allowFinal` is `false`. |
| `reachable` | `then` | Some reachable state satisfies `then`. |

Rule ids appear in reports as `invariant:Name`, `property:Name`, and
`deadlock:Name`, the same form the TLA+ path produces.

### Expressions

Expressions are parsed, never evaluated as code. The grammar has:

- Literals: numbers, `'strings'`, `true`, `false`.
- Names: context variables and `event.field`.
- Operators: `||`, `&&`, `!`, `==`, `!=`, `<`, `<=`, `>`, `>=`, `+`, `-`,
  `*`, `/`, `%`, `cond ? a : b`, and parentheses.
- Functions: `in('State.path')` (also accepts a node id or a unique trailing
  state key), `min`, `max`, `abs`. `in()` needs one literal string. Unknown or
  ambiguous state references stop checking; use a unique node ID or state path.

### Fairness

| Value | Behavior | TLC equivalent |
| --- | --- | --- |
| `"weak"` | Loops of real steps and dead ends are counterexamples. | `WF_vars(Next)` |
| `"none"` | The first state without the goal may stutter forever. | Spec without fairness |
| `{ "weak": ["E1"] }` | A loop that keeps `E1` enabled in every state but never takes it is not a counterexample. | `WF_vars(E1)` per listed event |

Strong fairness is not expressible.

## Guards and actions

The checker does not execute inline guard or action code from the model. Supply
each named guard and assign action as an expression in the rules file, derived
from the implementation.

- A guard with no expression is case-split: each step is explored with the
  guard true and with it false. This over-approximates behavior.
- An `assign` action with no expression marks the step unresolved. Its effect
  on context is unknown.

The report lists every unresolved guard and action.

## Verdicts

Each rule gets `holds`, `broken`, or `not-checked` independently.

- `holds` requires complete exploration. Reaching `maxStates` forbids `holds`.
- A safety rule (`never`, `initially`) that holds under case-split guards is
  `holds`. After any unresolved assignment, it is `not-checked`.
- A safety counterexample whose path crosses an unresolved guard or action is
  `not-checked`, because the path may be spurious. A fully resolved path to the
  violation is reported as `broken` even when a shorter uncertain path exists.
- Liveness rules and `no-dead-ends` are `not-checked` when any guard is
  unresolved.
- A `reachable` rule over a variable without a domain is `not-checked`.

## Outputs and exit codes

The output directory must be new or empty. It contains the same files as the
TLA+ path:

- `compact-report.md` and `report.md`: readable reports.
  The native report lists explored states, transitions, the state budget, and
  the rules-file fairness assumption. It does not use TLA+ limits.
- `check-result.json` (`stately.check-result.v1`) and `check-report.json`
  (`stately.check-report.v1`).
- `graph.json`: the native model with the check report attached. Pass it to
  `save_stately_check_result`.
  The saved check lists bound artifact paths and SHA-256 hashes. These bindings
  are separate from per-state source citations on an estimated application flow.
- The report's `recheck` block carries `modelPath` and `rulesPath` for native
  runs, alongside the TLA-named `specPath` and `configPath`.
- `run.json` and `inputs/`: run metadata and copies of the inputs.

Both native checker CLIs return `0` when every rule holds, `1` when a rule is
broken, and `2` when any rule is `not-checked`, exploration is incomplete, or the
checker errors. When rules are both broken and `not-checked`, the exit code is
`1`; read each rule's outcome in the report.

## Hosted checking

When the host cannot run commands, the `check_machine` MCP tool (hosted API
route `/api/v1/check`) runs the same native checker with host limits: at most
20000 states and 10 s. It takes `machine` (an XGraph or XState config, as an
object or JSON text) plus `format`, or `source` as in `simulate_machine`, and
`rules` (the rules-file object), with optional `limits`. It returns per-rule
verdicts, native traces, and a graph carrying the report. Save that graph with
`save_stately_check_result`. TLA+ is not available hosted.

## Reading counterexamples

Each trace step lists the active native node ids and the native edge id taken,
with the real event type and context. No projection or view file is needed;
the saved native view highlights the states at each step.

Liveness traces end in a lasso. `loopStart` is the step index where the
repeating part begins. `stutters: true` means the behavior stays in the last
state forever, either because it is a dead end or because fairness is `"none"`.

## Limits

- State is stored as explicit keys in memory. Models with a few hundred
  thousand configurations stay practical; there is no symmetry reduction or
  disk-backed state set.
- Payloads are finite lists, not per-field domains.
- There are no action constraints, views, or general temporal formulas.

## Worked example

`Login.json`:

```json
{
  "id": "login",
  "type": "parallel",
  "states": {
    "session": {
      "initial": "signedOut",
      "states": {
        "signedOut": { "on": { "SUBMIT": [{ "target": "signedIn", "guard": "valid" }, { "actions": "fail" }] } },
        "signedIn": { "on": { "LOGOUT": "signedOut" } }
      }
    },
    "lock": {
      "initial": "open",
      "states": {
        "open": { "always": { "target": "lockedOut", "guard": "tooMany" } },
        "lockedOut": {}
      }
    }
  }
}
```

`Login.rules.json`:

```json
{
  "context": { "tries": { "min": 0, "max": 3 } },
  "init": { "tries": 0 },
  "guards": { "valid": "event.ok", "tooMany": "tries >= 3" },
  "actions": { "fail": { "tries": "min(tries + 1, 3)" } },
  "events": { "SUBMIT": { "payloads": [{ "ok": true }, { "ok": false }] } },
  "rules": [
    { "id": "NoSignInWhileLocked", "kind": "never", "when": "in('signedIn') && in('lockedOut')" },
    { "id": "CanLockOut", "kind": "reachable", "then": "in('lockedOut')" },
    { "id": "NoDeadlock", "kind": "no-dead-ends" }
  ]
}
```

```sh
sh SKILL_DIR/scripts/stately-check check Login.json --rules Login.rules.json --out runs/login-1 --json
```

The run explores 8 configurations and exits `1`. `CanLockOut` and
`NoDeadlock` hold. `NoSignInWhileLocked` is broken because the `valid` guard
reads only the submitted credentials and ignores the lock:

```text
0. lock.open, session.signedOut, tries 0
1. SUBMIT { ok: false }: lock.open, session.signedOut, tries 1
2. SUBMIT { ok: false }: lock.open, session.signedOut, tries 2
3. SUBMIT { ok: false }: lock.lockedOut, session.signedOut, tries 3
4. SUBMIT { ok: true }: lock.lockedOut, session.signedIn, tries 3
```

Replay the path against the application before reporting a bug. If the real
guard also checks the lock, change the expression to
`event.ok && !in('lockedOut')` and rerun with a new `--out`.

## When to use TLA+ instead

Write a TLA+ model and follow [formal-checking.md](formal-checking.md) and
[model-authoring.md](model-authoring.md) when:

- The user supplies a `.tla` file or asks for TLA+.
- State is set-valued or function-valued, such as a set of prepared resource
  managers or a map from participant to status.
- The model needs model-value constants or symmetry.
- A property needs strong fairness or a temporal formula beyond the rule kinds
  above.
- Data is unbounded and a finite domain would change the question.
