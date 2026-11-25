# Checking engine attribution

Adapted from Lauren Tan’s MIT-licensed pstack statechart checking engine.
Source: https://github.com/cursor/plugins/tree/0b46ec399d55f2829e88822998f53b84944837d3/pstack/skills/statechart/scripts
Pinned upstream commit: `0b46ec399d55f2829e88822998f53b84944837d3` (pstack 0.15.46). See LICENSE.md.

Stately owns its entrypoint, toolchain setup, native rendering, report protocol,
and editor workflow. No pstack installation is required. The original checking
engine and regression corpus are retained to verify TLC semantics and projection.
Engine tests and development files are excluded from distributed plugin archives.

An earlier baseline was Michael Denyer's MIT-licensed Claude port,
`pstack-claude` 0.9.125 at `7641b0dd92464194d087906f4588c0bbbccdb5d8`:
https://github.com/michael-denyer/pstack-claude/tree/7641b0dd92464194d087906f4588c0bbbccdb5d8/plugins/pstack/skills/statechart
Its CRLF and Windows changes are now part of the official source. Stately's own
platform-aware supervisor and native PowerShell launcher run the installed
workflow; the upstream `statechart.ts`, `janitor.ts`, and `kill.ts` launchers are
retained for the regression tests and excluded from packaged archives.
`upstream.json` locks all 28 runtime sources and names each local adaptation;
`scripts/check-stately-engine.mjs` checks that lock, optionally against a newer
upstream checkout.

Local adaptation: `project()` also returns its resolved label mapping so native
trace bindings reuse the exact evaluated projection. Checker, verdict,
and projection algorithms are unchanged. The render test reads its colocated
upstream guide; package metadata contains only the ESM runtime boundary.

SANY additionally exposes loaded module names for exact local dependency
bindings. This is provenance metadata; checking algorithms remain unchanged.
