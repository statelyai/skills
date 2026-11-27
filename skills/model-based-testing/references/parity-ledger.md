# Parity ledger

The ledger (`e2e-parity.json`) records, for every legacy end-to-end test, how
the model test now covers it. `scripts/parity-check.mjs` checks it against the
runner's test inventory.

## Format

```json
{
  "version": 1,
  "tests": [
    {
      "id": "e2e/login.spec.ts > shows an error for a wrong password, then recovers",
      "status": "mapped",
      "events": [
        { "type": "FILL_EMAIL", "value": "ada@example.com" },
        { "type": "FILL_PASSWORD", "value": "nope" },
        { "type": "SUBMIT" },
        { "type": "FILL_PASSWORD", "value": "hunter2" },
        { "type": "SUBMIT" }
      ],
      "assertions": [
        { "legacy": "expect(page.getByRole('alert')).toHaveText('Wrong password')", "afterStep": 3, "oracle": "projectModel.error" },
        { "legacy": "expect(page).toHaveURL('/welcome')", "afterStep": 5, "oracle": "projectModel.screen" }
      ]
    },
    {
      "id": "e2e/login.spec.ts > login form matches visual snapshot",
      "status": "residual",
      "reason": "Screenshot comparison. The model does not describe pixels.",
      "keptIn": "e2e/login.spec.ts"
    },
    {
      "id": "e2e/login.spec.ts > logs in (old flow)",
      "status": "dropped",
      "reason": "Same sequence and assertions as 'logs in with valid credentials'.",
      "approvedBy": "Ada Lovelace"
    }
  ]
}
```

| Field | Required for | Description |
| --- | --- | --- |
| `id` | all | `<file relative to the runner root> > <describe titles> > <test title>`, as the inventory prints it. |
| `status` | all | `mapped`, `residual`, or `dropped`. `--init` writes `todo`, which fails the check. |
| `events` | `mapped` | Model events in the order the legacy test performed them, with the concrete payloads it used. JSON only. |
| `assertions[].legacy` | `mapped` | The legacy assertion, quoted from the test. |
| `assertions[].afterStep` | `mapped` | The number of events sent before the assertion ran. `0` is the initial state. |
| `assertions[].oracle` | `mapped` | What checks it now: `projectModel.<key>`, `states.<state>`, `invariant:<name>`, or `check:<name>`. |
| `reason` | `residual`, `dropped` | Why the model does not cover it. |
| `keptIn` | `residual` | Where the legacy test still runs. |
| `approvedBy` | `dropped` | The person who agreed to drop the coverage. |

Legacy tests that generate data (faker, random ids, timestamps) need a
recorded concrete value in `events`, and the model must accept any value the
generator could produce. Note the generator in `legacy`.

## Parity test, Vitest or a plain SUT

```ts
import { test } from 'vitest';
import type { EventFrom } from 'xstate';
import { testPaths } from '@xstate/test/paths';
import { loginMachine } from './login.machine';
import { sut } from './login.sut';
import ledger from './e2e-parity.json';

type Event = EventFrom<typeof loginMachine>;

for (const entry of ledger.tests.filter((t) => t.status === 'mapped')) {
  test(`parity: ${entry.id}`, async () => {
    await testPaths(loginMachine, { fromEvents: entry.events as Event[], sut });
  });
}
```

## Parity test, Playwright

```ts
import { test } from '@playwright/test';
import type { EventFrom } from 'xstate';
import { testPaths } from '@xstate/test';
import { createPlaywrightSut } from '@xstate/test/playwright';
import { loginMachine } from './login.machine';
import { loginPage } from './login.page';
import ledger from './e2e-parity.json' with { type: 'json' };

type Event = EventFrom<typeof loginMachine>;

for (const entry of ledger.tests.filter((t) => t.status === 'mapped')) {
  test(`parity: ${entry.id}`, async ({ page }, testInfo) => {
    await testPaths(loginMachine, {
      fromEvents: entry.events as Event[],
      sut: createPlaywrightSut(page, { ...loginPage, testInfo })
    });
  });
}
```

`loginPage` holds the `reset`, `events`, `read`, `projectModel`, and `mocks`
shared by the parity test and the generated test. Keep one adapter so both
tests observe the application the same way.

## Negative controls

An oracle control proves that `read()` observes what a legacy assertion
checked. For an assertion with `oracle: "projectModel.error"` after step 3,
make `projectModel` return a wrong `error` only in the state reached at step
3, run the parity test, and confirm that entry fails with
`observation diverged` at that step. Revert the change.

A bug control proves the suite catches a real regression. Break the
application the way a legacy test guards against (remove a guard, skip a
state update, return the wrong status from a mock), and confirm the legacy
test and its parity replay both fail. Revert the change.

Record the controls that ran in the pull request description, not in the
ledger.
