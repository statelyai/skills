# Parity ledger

`e2e-parity.json`, checked against the test inventory by
`scripts/parity-check.mjs`.

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
      "reason": "Screenshot comparison.",
      "keptIn": "e2e/login.spec.ts"
    },
    {
      "id": "e2e/login.spec.ts > logs in (old flow)",
      "status": "dropped",
      "reason": "Duplicates 'logs in with valid credentials'.",
      "approvedBy": "Ada Lovelace"
    }
  ]
}
```

| Field | Required for | Value |
| --- | --- | --- |
| `id` | all | `<file> > <describe titles> > <test title>`, as the inventory prints it |
| `status` | all | `mapped`, `residual`, or `dropped` (`--init` writes `todo`, which fails) |
| `events` | `mapped` | Model events in legacy order, with the payloads the test used |
| `assertions[].legacy` | `mapped` | The legacy assertion, quoted |
| `assertions[].afterStep` | `mapped` | Events sent before the assertion; `0` is the initial state |
| `assertions[].oracle` | `mapped` | `projectModel.<key>`, `states.<state>`, `invariant:<name>`, or `check:<name>` |
| `reason` | `residual`, `dropped` | Why the model does not cover it |
| `keptIn` | `residual` | Where the legacy test still runs |
| `approvedBy` | `dropped` | The person who approved dropping it |

For generated data (faker, random ids), record the value the test used and
make the model accept any generated value.

## Vitest

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

## Playwright

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

`loginPage` holds `reset`, `events`, `read`, `projectModel`, and `mocks`.
Share it with the generated test so both observe the page the same way.
