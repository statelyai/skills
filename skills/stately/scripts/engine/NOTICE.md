# Checking engine attribution

Adapted from Lauren Tan’s MIT-licensed pstack statechart checking engine.
Source: https://github.com/cursor/plugins/tree/ae5650febf4320793844c12c4adaa937f417f8da/pstack/skills/statechart/scripts
Pinned upstream commit: `ae5650febf4320793844c12c4adaa937f417f8da`. See LICENSE.md.

Stately owns its entrypoint, toolchain setup, native rendering, report protocol,
and editor workflow. No pstack installation is required. The original checking
engine and regression corpus are retained to verify TLC semantics and projection.
Engine tests and development files are excluded from distributed plugin archives.

Compatibility baseline also includes Michael Denyer's MIT-licensed Claude port,
`pstack-claude` 0.9.125 at `7641b0dd92464194d087906f4588c0bbbccdb5d8`:
https://github.com/michael-denyer/pstack-claude/tree/7641b0dd92464194d087906f4588c0bbbccdb5d8/plugins/pstack/skills/statechart
Its CRLF message normalization and Windows helper changes are retained. Stately's
own platform-aware supervisor and native PowerShell launcher provide the installed
workflow's Windows lifecycle support. `upstream.json` locks all 27 runtime sources
and names each local adaptation; `scripts/check-stately-engine.mjs` checks that
lock, optionally against a newer upstream checkout.

Local adaptation: `project()` also returns its resolved label mapping so native
trace bindings reuse the exact evaluated projection. Checker, verdict,
and projection algorithms are unchanged. The render test reads its colocated
upstream guide; package metadata contains only the ESM runtime boundary.

SANY additionally exposes loaded module names for exact local dependency
bindings. This is provenance metadata; checking algorithms remain unchanged.

Two fixes are ported from upstream commit
`bf0c7cd80abdbf7fe47b634978a7d1b4071f71a7`
(https://github.com/cursor/plugins/commit/bf0c7cd80abdbf7fe47b634978a7d1b4071f71a7)
ahead of a full rebase onto it:

- `backends/mermaid.ts`: an arrow from outside a parent state ends at the parent's
  border, and the parent's start marker leads to the state inside. A lone arrow
  keeps its label. When one state leads to several states inside, each label moves
  to the start marker's arrow. A parent that two or more states lead into keeps
  its direct arrows.
- `run.ts`: when SANY's XML run fails, the check reruns SANY in plain mode and
  reports that run's error section, capped at 40 lines, instead of a Java stack
  trace.

The matching upstream tests (`test/chart.test.ts`, `test/cli.test.ts`,
`test/corpus.test.ts`, `test/labels.ts`, `test/render.test.ts`, `test/drawn.ts`,
and the `Login` corpus chart) are ported with them.
