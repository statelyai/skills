---
name: xstate-v6
description: Write, review, test, and migrate XState v6 machines and actors by reading the documentation that ships inside the installed xstate package. Use when a project depends on xstate 6 (including betas), when the user asks for XState v6, or when migrating XState v5 code to v6. For a project on xstate 5, use the xstate-v5 skill instead.
---

# XState v6

XState v6 ships its documentation in the package, versioned with the code. Read
those docs instead of relying on memory, blog posts, or v5 examples. This skill
says where to find them, what to read first, and how to verify the result.

## Find the version and the docs

1. Read the importing workspace's `package.json` and lockfile. In a monorepo,
   each workspace can resolve a different `xstate`.
   - `xstate` 5.x: use the xstate-v5 skill, unless the user asked to migrate
     to v6. Then go to [Migrate from v5](#migrate-from-v5).
   - `xstate` 6.x: continue.
   - No `xstate`: ask before adding it. v6 is in beta (npm `latest` is still
     5.x); say so when you propose it.
2. Open `node_modules/xstate/docs/index.md` from that workspace. Its title is the
   exact installed version, and it links every page. `npx xstate docs` prints the
   same location.
3. Read `docs/agents.md` in full before writing code. It is the authoring
   contract: transition syntax, context patches, effects, serialization, the
   JSON CLI, and how to verify.
4. Read only the pages the task needs, from the index. Use `docs/cheatsheet.md`
   for syntax and `docs/api-stability.json` before using an export: it marks
   public, experimental, and internal exports for that version.

When the package is not installed and you may not install it, download the
tarball to a temporary directory and read its `docs/` folder there:

```sh
dir=$(mktemp -d) && cd "$dir" && npm pack xstate@beta && tar xzf xstate-*.tgz
```

Say which version you read when it is not the one the project will install.

## Rules worth repeating

These cause most v6 mistakes, so check them even after reading the docs:

- Transitions are objects or one function: `on: { GO: { target: 'done' } }`.
  A bare string such as `on: { GO: 'done' }` and transition arrays are v5
  syntax. `initial: 'idle'` stays a string.
- `xstate/fsm` exports `createFSM`, not `createMachine`.
- Do not copy v5 code, including from this repository's xstate-v5 skill, without
  translating it. `docs/xstate-v5-to-v6.md` lists every difference.
- Keep I/O, time, and randomness out of transition calculation. Queue effects or
  invoke actors, as `agents.md` describes.

## Design before code

- When the logic is a few independent values, say a machine is unnecessary and
  suggest plain state or `@xstate/store`.
- When requirements are unclear, sketch the states and events (a short list or
  a JSON config) and confirm it before writing TypeScript.
- Keep target literals visible so the graph can be inspected and visualized.

## Verify

- Typecheck without suppressions or broad casts.
- Run the project's tests. Add tests for the paths you changed, including
  failure, cancellation, and stop.
- For a data-only definition, use the CLI that ships with the package:
  `npx xstate validate`, `simulate`, `test` (with `never` and `reachable`
  checks), and `replay` for a saved counterexample. The input formats are in
  `agents.md`. A passing `test` covers only the event representatives you
  supplied; report it that way.
- When fixing a bug, save the failing event sequence first and replay it after
  the fix.

## Migrate from v5

Follow `docs/xstate-v5-to-v6.md` and the `@xstate/codemod` loop in
`agents.md`: `baseline`, then `migrate`, fix the reported `manualSites`, then
`verify` against the baseline. Do not report a migration as done until
`verify` exits 0.

To view or check a machine in Stately, use the `stately` skill.
