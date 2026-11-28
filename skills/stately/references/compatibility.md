# Statechart compatibility contract

Stately covers every workflow capability of the pstack `statechart` engine it
vendors, plus native report/playback, source freshness, guarded rechecking, and
separate application evidence. No installed pstack, mise, or XState migration is
needed. This is a versioned feature/behavior contract, not a claim that extra
artifact generation always runs faster or that a finite model proves application
code.

## Vendored engine version

- **Engine:** Lauren Tan's MIT-licensed pstack `/statechart` checking engine
  ([upstream repository](https://github.com/cursor/plugins/tree/main/pstack)).
  See [Credits](#credits).
- **Vendored commit:** the 28 runtime files in `scripts/engine/` are pinned to
  the official source at
  [`cursor/plugins@0b46ec39`](https://github.com/cursor/plugins/tree/0b46ec399d55f2829e88822998f53b84944837d3/pstack/skills/statechart),
  which is pstack release 0.15.46. That release includes the CRLF and native
  Windows changes first made in Michael Denyer's Claude port and the fixes from
  [`cursor/plugins@bf0c7cd8`](https://github.com/cursor/plugins/commit/bf0c7cd8).
- **Parity:** `scripts/check-stately-engine.mjs` compares file hashes against
  commit `0b46ec39`, not against the latest pstack release. A newer pstack
  release is not vendored until its delta is reviewed as described below.
- **Local edits:** listed with their hashes in `scripts/engine/upstream.json`:
  `frontends/spec.ts` and `ir.ts` expose loaded SANY module names, and
  `pipeline.ts` returns resolved projection labels (metadata only).
  Checker and verdict algorithms are unchanged.

| Statechart capability                                                                       | Stately coverage                                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Existing/new finite TLA+, any application framework                                         | Owned checker and [modeling guide](model-authoring.md)                                 |
| Safety, temporal properties/fairness, deadlocks, constraints, multiple rules                | Same pinned TLC flags and checking engine; complete regression corpus                  |
| Independent outcomes, shortest safety paths, lasso/stutter witnesses, rerun bounds          | Same verdict/path algorithms; complete JSON and native variable playback               |
| Typed TLA values and default labels                                                         | Same typed default projection; model-value/string distinction regression               |
| Custom state/step/group/colors/title, hierarchy, parallel regions, hidden/conditional steps | Same projection/Mermaid backends; explicit coarsening limits                           |
| 500-state charts and 100000-state reruns                                                    | Same budgets; explicit summary-only native fallback                                    |
| Markdown, Mermaid, numbered paths, raw/per-rule TLC output                                  | Original compact report plus complete scoped report and original artifacts             |
| Portable SVG with failure/path/loop classes and light/dark themes                           | Owned lazy pinned Pele renderer; [rendering guide](render.md)                          |
| Node/Bun/Deno minimums; Linux/macOS/Windows lifecycle                                       | Shell/native PowerShell launchers; installed-ZIP real TLC matrix                       |
| CRLF TLC output                                                                             | Normalized message markers; real TLC CRLF regression                                   |
| `SPEC.tla`, `--config`, `--view`, `--out`, equals syntax, options first, `--`               | Owned CLI; omitted output defaults to `SPEC-chart`; `check` remains optional           |
| Refuse overwrites; signal/parent-death cleanup                                              | Owned supervisor/registered worker, including provisioning and installer-stage cleanup |
| Replay bugs against existing application; expose modeling uncertainty                       | Required workflow; application observations recorded independently                     |
| Pair with create/maintain-formal-verification skills                                        | [Optional pairing](verification-pairing.md); preserve other proof backends             |

## Earlier statechart releases

Earlier pstack `statechart` releases (October 2026) had commands and flags that
the current release dropped. Each maps to a Stately workflow:

| Earlier statechart capability                                                 | Stately coverage                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `from-spec`: chart from a TLA+ model                                          | [Check invariants](../SKILL.md#check-invariants), native or TLA+, saved as a native view                                                                                                                                            |
| `from-chart`: agreed chart to TLA+ skeleton, then diff against code           | Agreed model and code model, both checked with the same rules ([model-authoring.md](model-authoring.md)); the agreed model is a Stately machine checked natively, so no TLA+ skeleton step is needed; `diff_machines` compares them |
| `--against` / `--against-config`: audit a code model against an existing spec | Same agreed-versus-code workflow; the existing spec keeps its rules and config                                                                                                                                                      |
| `--fixed`: proposed fix in the same chart                                     | [Check a fix](../SKILL.md#check-a-fix) and `stately-check compare`, rule by rule, with counterexample replay                                                                                                                        |
| `--png`                                                                       | Stately view link for every run; `render` SVG on request                                                                                                                                                                            |
| `--cover`: shortest paths to settled states plus bug paths                    | `stately-check view --trace` selection and the native summary-only view, every verdict kept                                                                                                                                         |
| `state`, `step`, `group`, `cause`, `readerActions` labels                     | Domain-language labels in the model and report; TLA+ runs keep the same view module                                                                                                                                                 |
| `--expect-broken` goal rules                                                  | Native `reachable` rule kind, reported as reachable, not as a bug                                                                                                                                                                   |
| `Settled == ~ENABLED System` rules                                            | Native `eventually` and `eventually-always` rule kinds                                                                                                                                                                              |
| `stories.md`                                                                  | `compact-report.md`, `report.md`, and the domain-language explanation                                                                                                                                                               |
| Counts only from `summary.json`                                               | Counts only from `check-report.json` or `report.md`                                                                                                                                                                                 |
| No "holds" while conditions lack file and line                                | Citations on guards and conditions; the report lists uncited conditions, and "holds" names them as unconfirmed                                                                                                                      |
| One model step per indivisible code step                                      | Same rule in [model-authoring.md](model-authoring.md)                                                                                                                                                                               |

## The implicit state machines prompt

The prompt "find all of the implicit state machines in my app" (Steve Ruiz,
October 2025) and its variants ask a model to list hidden state machines. Each
part maps to a stronger Stately workflow:

| Prompt outcome                         | Stately coverage                                                                                                                                                |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A list of implicit machines            | Area inventory and full sweep with a coverage record ([implicit-machines.md](implicit-machines.md#cover-the-whole-scope)); every candidate ranked, none dropped |
| States and transitions of each machine | Inventory document with a transition table citing `path:line`, updated in place on re-runs                                                                      |
| Possible bugs                          | Twelve state bug kinds, absence checks, and the evidence format with a re-trace ([state-bugs.md](state-bugs.md))                                                |
| Diagrams                               | A Stately link per candidate, in rank order                                                                                                                     |
| Refactor suggestions                   | [Make a machine explicit](../SKILL.md#make-a-machine-explicit): tests first, XState v6, replaced flags deleted, the real machine checked with the same rules    |
| Confidence that a fix works            | [Check a fix](../SKILL.md#check-a-fix) and an application replay                                                                                                |
| Review of new changes                  | [Review a change for state bugs](../SKILL.md#review-a-change-for-state-bugs), benchmarked in the evaluation results                                             |
| Fewer implicit machines later          | The repository rule in [Prevent new implicit machines](implicit-machines.md#prevent-new-implicit-machines)                                                      |

## Maintain the contract

`scripts/engine/upstream.json` records all 28 upstream runtime source hashes at
the [exact upstream commit](https://github.com/cursor/plugins/tree/0b46ec399d55f2829e88822998f53b84944837d3/pstack/skills/statechart),
plus the three local label/module-provenance adaptations. Record every future edit under
`scripts/engine/` in `upstream.json` and in [Vendored engine version](#vendored-engine-version). Packaging omits unused legacy
launchers and the development corpus; the owned runtime needs neither.

Repository checks run the source lock before checker/workflow tests. To audit a
new upstream checkout without making it a runtime dependency:

```sh
node scripts/check-stately-engine.mjs --upstream /path/to/statechart/scripts
pnpm test:skill
pnpm test:plugin
```

An added, missing, or changed runtime file fails the source check. Review every
upstream delta, update the explicit adaptation record, and add behavior cases
before changing the baseline. Source equality complements actual TLC and
installed-package checks; it does not replace them. Record executed platforms
and test receipts in the repository's evaluation results.

## Credits

The TLA+ checking engine behind `/stately` is Lauren Tan's pstack
`/statechart` skill and engine, released under the MIT License. Its TLC
integration, verdict and path algorithms, projection, Mermaid output, report
format, and regression corpus are her work, and Stately builds on them directly.

- Upstream: [github.com/cursor/plugins, `pstack/skills/statechart`](https://github.com/cursor/plugins/tree/0b46ec399d55f2829e88822998f53b84944837d3/pstack/skills/statechart),
  commit `0b46ec399d55f2829e88822998f53b84944837d3` (pstack 0.15.46).
- Claude port: Michael Denyer's MIT-licensed [`pstack-claude`](https://github.com/michael-denyer/pstack-claude/tree/7641b0dd92464194d087906f4588c0bbbccdb5d8/plugins/pstack/skills/statechart)
  0.9.125 was the earlier baseline. Its CRLF and Windows changes are now part
  of the official source.
- License and notice: [`scripts/engine/LICENSE.md`](../scripts/engine/LICENSE.md)
  and [`scripts/engine/NOTICE.md`](../scripts/engine/NOTICE.md). The rendering
  guide in [render.md](render.md) is also adapted from her work.

Thank you, Lauren, for making this engine open and for the care that went into
its regression corpus.
