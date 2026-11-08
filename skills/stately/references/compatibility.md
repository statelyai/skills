# Statechart compatibility contract

Stately owns every workflow capability of pstack Claude `statechart` 0.9.125,
plus native report/playback, source freshness, guarded rechecking, and separate
application evidence. No installed pstack, mise, or XState migration is needed.
This is a versioned feature/behavior contract, not a claim that extra artifact
generation always runs faster or that a finite model proves application code.

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

## Maintain the contract

`scripts/engine/upstream.json` records all 27 upstream runtime source hashes at
the [exact Claude-port commit](https://github.com/michael-denyer/pstack-claude/tree/7641b0dd92464194d087906f4588c0bbbccdb5d8/plugins/pstack/skills/statechart),
plus the three local label/module-provenance adaptations. The MIT attribution
also records the original official source. Packaging omits unused legacy
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
