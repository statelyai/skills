---
name: model-based-testing
description: Write model-based tests with @xstate/test 2.0 beta, replace end-to-end tests with model-based tests without losing coverage, and visualize the model in Stately. Use for model-based testing, @xstate/test, generating tests from a state machine, testing every path, replacing Playwright, Cypress, Vitest, or Jest end-to-end tests with a model, coverage parity, or migrating from @xstate/test 0.x or 1.0 beta.
---

# Model-based testing

Rules:

- Read the docs that ship with the installed packages before writing code.
- Show the model in Stately after every change.
- Report only runs, coverage, and parity results that happened.
- Delete a legacy test only after its parity entry passes the check and its
  negative controls.

## Set up

1. `@xstate/test` 2.x requires `xstate` 6. With no `xstate`, propose
   `@xstate/test@beta xstate@beta fast-check` as dev dependencies and say they
   are betas. With `xstate` 5, ask before upgrading, or put the model tests in
   a separate workspace package with `xstate@beta`.
2. Read `node_modules/@xstate/test/README.md` (API) and
   `node_modules/xstate/docs/model-based-testing.md`. Write the machine in v6
   syntax (`node_modules/xstate/docs/agents.md` or the `xstate-v6` skill). If
   the packages are not installed, read the tarballs:

   ```sh
   dir=$(mktemp -d) && cd "$dir" && npm pack @xstate/test@beta xstate@beta && for f in *.tgz; do mkdir "${f%.tgz}" && tar xzf "$f" -C "${f%.tgz}"; done
   ```

3. Use `testPaths` in CI (`@xstate/test/paths` needs no fast-check). Add
   `propertyTest` with `until` when payloads, ordering, or timing matter, or
   the graph is too large to enumerate. Use `createPlaywrightSut` for web
   pages.

`2.0.0-beta.3` with `@playwright/test` 1.64+: `createPlaywrightSut(page)`
fails to type-check (`tracing.start()` returns `Promise<Disposable>`). Tell
the user, and check for a fixed release before adding a cast.

## Write a model test

1. Write the model from requirements and existing tests, not from the code
   under test. Mark parts taken from code and ask the user to confirm them.
2. Model only what a user can see and do, one machine per flow. Declare
   `meta: types<{ requirements?: string | string[] }>()` in `schemas` to use
   `meta.requirements`.
3. Visualize the model and confirm it with the user before writing the SUT.
4. `projectModel(snapshot)` and `read()` return the same shape, containing
   only what the UI shows.
5. The SUT resets in `create()` (Playwright: `reset`), waits in `settle()`,
   and stubs the network per event case with `mocks` or `outcomes`.
6. Bound growing context with `stopWhen` or `serializeState`. Do not raise
   `limit` to fix a `limit` error.
7. Gate with `assertTestCoverage(coverage, { transitions: 1, stateNodes: 1 })`
   and set `failures: true`.

## Replace end-to-end tests

Generated paths may skip a legacy test's sequence, and the projection may
miss what it asserted. Track each legacy test in a ledger. Format and
templates: [references/parity-ledger.md](references/parity-ledger.md).

1. Inventory with the runner, not by reading files:

   ```sh
   npx playwright test --list --reporter=json > e2e-inventory.json
   npx vitest list e2e --json=e2e-inventory.json
   ```

2. `node <skill-dir>/scripts/parity-check.mjs --inventory e2e-inventory.json --init > e2e-parity.json`
3. For each test, read the body, hooks, fixtures, and page objects. Record
   its user actions as `events` (setup goes in `input`, reset, or `mocks`),
   each assertion with `afterStep` and its `oracle`, and a `status`:
   - `mapped`: covered by the model test.
   - `residual`: the model cannot express it; the legacy test stays (`keptIn`).
   - `dropped`: only with the user's approval (`approvedBy`).

   Extend the model or projection until every assertion has an oracle. Never
   weaken an assertion.
4. Replay each mapped entry with `testPaths(machine, { fromEvents })`. On
   `Path diverged`, fix the model or adapter, not the ledger.
5. Add generated coverage (`pathGenerator: 'edges'`) with `assertTestCoverage`.
6. `node <skill-dir>/scripts/parity-check.mjs --inventory e2e-inventory.json --ledger e2e-parity.json`
   must exit 0.
7. Negative controls: for each assertion, change the value the application
   shows at that step (edit the app, a mock, or fixture data) and confirm the
   replay fails there. Changing `projectModel` alone does not prove `read()`
   observes the value. If no application-side change is possible, mark the
   test residual. Revert every control.
8. Run both suites in CI under the legacy suite's browser projects. After a
   green run, delete mapped tests, keep residual ones, and commit the ledger.

Usually residual: screenshots, accessibility audits, exact request payloads,
analytics, performance, copy not in the projection, multiple tabs or users.

## Visualize the model

- `visualize_machine` with `{ machine: "<model source>", format: "xstate" }`.
  In a terminal, add `presentation: "unicode"` and show the diagram in a code
  block.
- Legacy coverage: `open_stately_editor` with one `session.highlights` entry
  `{ kind: "scenario", label: "<test id>", scenario: { events } }` per mapped
  test.
- A failure: pass the trace's events as `session.simulation`.

Copy links exactly. Without a Stately connection, say how to sign in (Claude
Code: `/mcp`, authenticate `stately`; Codex: `codex mcp login stately`).

## Migrate from 0.x or 1.0 beta

Follow the installed README's migration section. Keep the old tests until the
new ones pass with equal or higher state node coverage.

## Report

Model file and Stately link, test command and result, coverage summary. For a
replacement, add the parity check output, the negative controls that ran, and
the residual tests.
