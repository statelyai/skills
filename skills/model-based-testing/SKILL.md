---
name: model-based-testing
description: Write model-based tests with @xstate/test 2.0 beta (testPaths, propertyTest, createPlaywrightSut), replace existing end-to-end tests with model-based tests without losing coverage, and visualize the test model in Stately. Use when the user mentions model-based testing, @xstate/test, property-based testing of UI flows, generating tests from a state machine, testing every path, replacing or consolidating Playwright, Cypress, Vitest, or Jest end-to-end tests with a model, coverage parity, or migrating from @xstate/test 0.x or 1.0 beta.
---

# Model-based testing

A model-based test describes expected behavior as an XState machine (the
model), generates event sequences from it, sends each sequence to the model and
to the application (the system under test, or SUT), and fails when the two
disagree. This skill covers three tasks:

| Request | Section |
| --- | --- |
| "write model-based tests for this flow" | [Write a new model test](#write-a-new-model-test) |
| "replace these e2e tests with model-based tests" | [Replace end-to-end tests](#replace-end-to-end-tests) |
| "migrate from @xstate/test 0.x or 1.0 beta" | [Migrate older @xstate/test code](#migrate-older-xstatetest-code) |

Rules that apply everywhere:

- Read the docs that ship with the installed packages before writing code. The
  API is in beta and changes between releases.
- Show the model in Stately every time you create or change it. See
  [Visualize the model](#visualize-the-model).
- Keep three kinds of evidence separate in every answer: what the model says,
  what the model test run proved, and what legacy tests still cover. Never
  report a run, coverage number, or parity result that did not happen.
- Never delete a legacy test until its parity entry is complete and verified.
  See [Replace end-to-end tests](#replace-end-to-end-tests).

## Set up

1. Read the importing workspace's `package.json` and lockfile.
   `@xstate/test` 2.x requires `xstate` 6 (`xstate@beta`).
   - `xstate` 6 installed: continue.
   - No `xstate`: propose `pnpm add -D @xstate/test@beta xstate@beta fast-check`
     (use the project's package manager). Say that both are beta releases.
   - `xstate` 5 installed in the same workspace: the model needs v6. Ask before
     upgrading. The usual alternative is to put the model tests in their own
     workspace package (end-to-end suites often already are one), with
     `xstate@beta` as a dev dependency there. Do not write the model in v5
     syntax.
2. Read, from that workspace:
   - `node_modules/@xstate/test/README.md`: the full API, options, and errors.
   - `node_modules/xstate/docs/model-based-testing.md`: the tutorial.
   - `node_modules/xstate/docs/agents.md` before writing machine code, or use
     the `xstate-v6` skill. v6 transitions are objects or functions, not
     strings.

   When the packages are not installed and you may not install them, read the
   published tarball instead:

   ```sh
   dir=$(mktemp -d) && cd "$dir" && npm pack @xstate/test@beta xstate@beta && for f in *.tgz; do mkdir "${f%.tgz}" && tar xzf "$f" -C "${f%.tgz}"; done
   ```

   The files land in `xstate-test-<version>/package/README.md` and
   `xstate-<version>/package/docs/`. Say which version you read.

3. Pick the entry point:

   | Need | Use |
   | --- | --- |
   | Deterministic paths, no fast-check dependency | `testPaths` from `@xstate/test/paths`, with `cases` or payload functions |
   | Every path, or every edge, through a finite graph | `testPaths` from `@xstate/test` (`pathGenerator: 'shortest' \| 'simple' \| 'edges'`) |
   | Exact replay of a known event sequence | `testPaths(machine, { fromEvents })` |
   | Random sequences, payload variety, shrinking, timing | `propertyTest` |
   | A web page | `createPlaywrightSut` from `@xstate/test/playwright` |
   | Vitest one-liners with failure replay | `it.model` and `it.paths` from `@xstate/test/vitest` |

   Known issue in `2.0.0-beta.3`: `createPlaywrightSut(page)` fails to
   type-check with `@playwright/test` 1.64 and later, because
   `page.context().tracing.start()` returns `Promise<Disposable>` and
   `PlaywrightPage` expects `Promise<void>`. It works at runtime. Tell the
   user, and check whether a newer `@xstate/test` release fixed it before
   adding a cast.

   Default to `testPaths` in CI. Add `propertyTest` with an `until` budget when
   payloads, ordering, or timing matter, or when the graph is too large to
   enumerate.

## Write a new model test

1. **Write the model from the specification, not from the implementation.** A
   model copied from the code under test agrees with that code's bugs. Use
   product requirements, the user's description, and existing tests. When you
   must read the implementation to learn the behavior, say which parts of the
   model came from code, and ask the user to confirm them.
2. **Keep the model small.** Model what a user can observe and do. One
   machine per flow. Put payload-dependent rules in transition functions so
   the graph stays finite. Add `meta.requirements` ids on state nodes and
   transitions that trace to specific requirements; coverage reports them.
   v6 type-checks `meta` against `schemas.meta`, so declare
   `meta: types<{ requirements?: string | string[] }>()` in `schemas`.
3. **Visualize the model** (next section) and confirm the states and events
   with the user before writing the SUT adapter.
4. **Design the projection.** `projectModel(snapshot)` and `read()` must
   return the same shape. Project only what the UI shows: the visible screen,
   messages, counts, enabled controls. Most false failures come from a
   projection that includes values the UI does not show, or omits a value
   that differs between two states.
5. **Write the SUT adapter.** One `send` branch per event type, a `read()` that
   reads the projection, and a reset in `create()` (or `reset` for Playwright)
   so every run starts clean. For async UIs, implement `settle()` or wait on a
   locator in Playwright's `settle`. Stub the network per event case with
   `mocks` or `outcomes`, never the real backend.
6. **Bound the graph.** Use `stopWhen`, `serializeState`, or `limit` when
   context can grow without bound. A `limit` error means the graph is not
   bounded, not that the test needs a higher limit.
7. **Run and gate.** Run the test. Gate CI with
   `assertTestCoverage(coverage, { transitions: 1, stateNodes: 1 })`. Turn on
   `failures: true` (or `{ key }` per test) so failures replay first, and
   commit regression fixtures with `replayTest(..., { expect: 'pass' })`.
8. **Report** the coverage report text, the number of paths or runs, and any
   uncovered or unreachable ids. Coverage is relative to the supplied event
   cases; say so.

## Replace end-to-end tests

The goal is that no behavior a legacy test checks goes unchecked after the
legacy test is deleted. A legacy test checks two things: a sequence of user
actions, and assertions at points in that sequence. Model-generated paths
alone do not guarantee either: the shortest-path generator may never take the
exact sequence, and the projection may not include the value an assertion
read. Parity is tracked per legacy test in a ledger file, checked by a
script, and proved by negative controls.

Read [references/parity-ledger.md](references/parity-ledger.md) for the
ledger format and test templates before starting.

1. **Inventory the legacy tests** with the runner's own listing, not by
   reading files:

   ```sh
   npx playwright test --list --reporter=json > e2e-inventory.json
   npx vitest list e2e --json=e2e-inventory.json
   ```

   For other runners, write a JSON array of `{ "id": "<file> > <title path>" }`.
2. **Create the ledger skeleton**:

   ```sh
   node <skill-dir>/scripts/parity-check.mjs --inventory e2e-inventory.json --init > e2e-parity.json
   ```

3. **Map each legacy test.** Read the test body, including its hooks,
   fixtures, and page objects. For each one, record:
   - `events`: the user actions as model events, in order, with the concrete
     payloads the test used. Setup that is not a user action (seeding data,
     signing in through an API, navigating) belongs in `input`, the SUT's
     reset, or `mocks`, not in `events`.
   - `assertions`: each `expect` with the step it follows (`afterStep`) and
     the oracle that now checks it: a `projectModel` key, a `states` key, an
     `invariant`, or a `check`.
   - `status`: `mapped`, `residual` (the behavior cannot be expressed in the
     model; the legacy test stays, named in `keptIn`), or `dropped` (redundant
     or obsolete; requires `approvedBy`, a person's name, after the user
     agrees). Never set `dropped` without asking the user.

   Extend the model and the projection until every assertion has an oracle.
   When an assertion reads something the model does not describe, either add
   it to the model or mark the test residual. Do not weaken the assertion.
4. **Write the parity test**: one `testPaths(machine, { fromEvents })` call per
   mapped entry, generated from the ledger (template in the reference). A
   `Path diverged` failure means the model rejects a sequence the legacy test
   performed: the model is wrong or incomplete, or the legacy test relied on
   setup the adapter does not reproduce. Fix the model or the adapter, not
   the ledger.
5. **Add generated coverage** next to the parity test: `testPaths` with
   `pathGenerator: 'edges'` or `'simple'`, and `assertTestCoverage`. This is
   what the migration gains over the legacy suite.
6. **Check the ledger**:

   ```sh
   node <skill-dir>/scripts/parity-check.mjs --inventory e2e-inventory.json --ledger e2e-parity.json
   ```

   Exit 0 means every legacy test has a complete entry. It does not prove the
   oracles work; step 7 does.
7. **Run negative controls.** For each mapped assertion, change the matching
   `projectModel` key so it returns a wrong value only at that assertion's
   state, and confirm the parity replay fails at that step. This proves the
   SUT's `read()` observes the value the legacy assertion checked. Where
   feasible, also inject the bug a legacy test guards against into the
   application and confirm the legacy test and its parity replay both fail.
   Revert every control. Report which controls ran.
8. **Run both suites** in CI for at least one green run. Then delete the
   mapped legacy tests, keep the residual ones, rerun the inventory and the
   parity check (deleted tests now show as warnings, which is expected), and
   commit the ledger next to the model test so reviewers can audit the
   mapping.

Run the model test under the same browser projects, viewports, and
environments as the legacy suite. A Playwright config with three projects ran
each legacy test three times.

### What model tests do not replace

Mark these residual unless the model covers them explicitly:

- Screenshot and visual comparisons, layout, and styling.
- Accessibility audits (unless added as a `check()` on the session).
- Exact request payloads, analytics events, and third-party integrations
  (unless recorded by the adapter and asserted in `check()`).
- Performance, load, and timing budgets.
- Copy and localization checks the projection does not include.
- Behavior across reloads, multiple tabs, or multiple users, unless the model
  has events for them.

## Visualize the model

After creating or changing a model, show it in Stately with the `stately`
skill's tools. Pass the model file's source text:

- `visualize_machine` with `{ machine: "<source text>", format: "xstate" }`
  returns a Stately link. In a terminal, add `presentation: "unicode"` and
  show the returned text diagram in a code block.
- To show which legacy tests cover which paths, call `open_stately_editor`
  with `session.highlights`: one `{ kind: "scenario", label: "<legacy test
  id>", scenario: { events } }` per mapped ledger entry.
- To show a failure, pass the failing trace's events as `session.simulation`.

Copy the returned link exactly. Without a Stately connection, give the model
file path and say how to sign in (in Claude Code, run `/mcp` and authenticate
`stately`; in Codex, run `codex mcp login stately`).

## Migrate older @xstate/test code

Follow "Migrating from `@xstate/test` 0.x and 1.0 beta" in the installed
README. `createTestModel(machine).getShortestPaths()` and `path.test()` become
`testPaths(machine, { sut })`; `withEvents({ E: { exec, cases } })` becomes
`events` for payloads and `sut.create().send` for `exec`; `meta.test`
receives `(session, snapshot)`. The model must also move to XState v6. Keep
the old test running until the new one passes and reports equal or higher
state node coverage.

## Report

End with: the model file and its Stately link, the test command and its
result, the coverage report summary, and for a replacement, the parity check
output, the negative controls that ran, and the residual tests that remain.
