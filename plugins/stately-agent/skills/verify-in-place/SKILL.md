---
name: verify-in-place
description: Verify existing agent code without changing it. Write a model of its control flow as a @statelyai/agent machine, prove the model's rules with canReach, record runs of the unchanged code, and check them against the model with checkConformance and traceCoverage. Use when asked to "verify my agent without rewriting it", "check my existing agent against a model", "prove my loop never does X", "model my existing workflow", "conformance", or "add guarantees to this agent" for code that already runs and should stay as it is. Migration to a machine is a separate step (loop-to-machine).
metadata:
  internal: true
---

# Verify existing code in place

> Targets `@statelyai/agent` 2.0 alpha, as on the [`next` branch](https://github.com/statelyai/agent/tree/next). Needs a version whose `@statelyai/agent/testing` exports `checkConformance` and `recordAiSdk`, and whose `RecordedModelCall` type has `aiSdkCall` (check the package, not the version number). APIs change between alphas: when a call here does not match the installed package, check `node_modules/@statelyai/agent/CHANGELOG.md`.

You leave the code alone and build evidence about it: a model of its control flow, proofs of the model's rules, and a check that recorded runs of the code conform to the model.

```
rules → seam → model → proofs → record → map → conformance → coverage → bite check → hand back
```

The claim you hand back is "the model is proved, and these recorded runs conform". Never "the code is verified": a run nobody recorded can still break a rule. Runtime enforcement comes from migrating with `loop-to-machine`, which this skill does not do.

Worked example: [examples/verify-in-place](https://github.com/statelyai/agent/tree/next/examples/verify-in-place). Guide: [docs/verify-in-place.md](https://github.com/statelyai/agent/blob/next/docs/verify-in-place.md).

## 1. Read the code: rules and units of work

- Write each rule as one sentence a search can falsify: "a refund over 100 never runs without approval", "at most 3 decisions". Read thresholds and caps from the code; ask the user only for rules the code does not state.
- List the units of work: each side effect the loop makes (a model call, a tool, a write, a person's answer). Each one becomes a model actor or event.

## 2. The seam

The check records the code's side effects without editing it.

| The code | Record with |
| --- | --- |
| Side effects go through one object or injected functions | `recorder.fn(name, fn)` around each function |
| It calls an SDK client it receives | `recorder.client(name, client, { methods })` |
| It receives an AI SDK model | `recorder.model(standIn)` (no name argument), plus the AI SDK recipe below so retries are attributed |
| It builds an AI SDK model inline, or passes module-level tools to `generateText` | The AI SDK recipe below |
| Other side effects are module imports with no injection point | Module mocks in the test (`vi.mock`) that wrap the real functions with `recorder.fn` |
| A framework takes an AI SDK model through its own adapter (openai-agents `aisdk(model)`) | `recorder.model(standIn)` passed to that adapter and set as the framework's default model. Every agent the scenario builds must resolve to the stand-in: override each agent's own `model` with it, and mock the provider packages (`vi.mock("@ai-sdk/openai")`) to throw, so a call to any other model fails the scenario |
| It does its work when imported (calls `main()`, reads stdin, calls `process.exit`) | Mock stdin (`node:readline`) and `process.exit`, call `vi.resetModules()`, then a dynamic `import()` per scenario (a cached module does not run `main()` again); keep seam state on `globalThis` so it survives the reset. `import()` can resolve while an unawaited `main()` still runs, so wait for a completion signal (the mocked `process.exit`, or the last mocked effect resolving a promise) before reading the recording or starting the next scenario. The mocked `process.exit` must stop execution at the call, so nothing after it runs or is recorded, and its exit code is the scenario's outcome. A thrown sentinel does this only when no application `catch` or `finally` wraps the exit and the scenario handles `main()`'s rejection (an unawaited `main()` rejects unhandled, so catch the sentinel in a `process.on("unhandledRejection")` handler). Otherwise run each scenario in a child process and read its exit code |

**AI SDK code.** Mock `"ai"` with `recordAiSdk`: each `generateText` and `streamText` call runs on the real AI SDK with the seam's model in place of the code's, and its tools wrapped with `recorder.tools`. The code's own tool loop runs, and the provider needs no mock:

```ts
// seam.ts: current = { recorder, model: recorder.model(new MockLanguageModelV3(...)) } per scenario
export const currentSeam = () => current;

// the test
vi.mock("ai", async (importOriginal) => {
  const ai = await importOriginal<typeof import("ai")>();
  const { recordAiSdk } = await import("@statelyai/agent/testing");
  const { currentSeam } = await import("./seam");
  return { ...ai, ...recordAiSdk(ai, currentSeam) };
});
```

- The seam module must not import `"ai"`, or the mock deadlocks. Import error classes from `@ai-sdk/provider`.
- `recordAiSdk` replaces the model, not the tools: each tool's real `execute` runs. Before recording, read every tool the code passes. A tool with an external effect (it moves money, sends a message, writes to a shared store) must run against a stand-in: mock the module or client it calls, the same way as other module imports. Ask the user before any scenario would reach a real external system, and never record against production.
- A call while `currentSeam()` returns `undefined` throws, so no test reaches a real provider.
- A tool with `execute` runs inside the `generateText` call, before the loop sees the result. Read the loop with that order, not line by line: a check the loop makes after `generateText` returns comes after the tool already ran.
- `recorder.model` records each provider attempt, and `effect.call` counts attempts. `recordAiSdk` stamps each attempt with `aiSdkCall`, the `generateText` call it belongs to: attempts with the same `aiSdkCall` are one call the code made (its tool-loop steps and the SDK's retries). Count the code's calls by `aiSdkCall`.
- A failed attempt followed by the same request has `retriedBy`. If the `retriedBy` attempt has the same `aiSdkCall`, the SDK retried it: skip it in the mapping. If it has a different `aiSdkCall`, the code resent it: keep it, so the model checks the code's retry path and call limit. An attempt with no `aiSdkCall` was not routed through `recordAiSdk`, so who resent it is unknown: keep it, and list retry attribution as a coverage gap in the hand-back.
- Code that receives its model still calls `generateText`: mock `"ai"` with `recordAiSdk` and leave `model` out of the seam. The injected `recorder.model` wrapper is then indexed by call, so its SDK retries are skipped like any other.

If none of these reach a side effect, the only edit allowed is extracting a seam (an `effects` object passed in). Ask the user before making it, make it its own commit, and change nothing else. The hand-back then names that commit as the one change to the code. Without the user's approval, stop and report which side effects no seam reaches.

## 3. The model file

Write `<name>.model.ts` beside the code: a `setupAgent` machine with the code's control flow.

```ts
const placeholder = <I, O>(input: z.ZodType<I>, output: z.ZodType<O>) =>
  createAsyncLogic({
    schemas: { input, output },
    run: (): Promise<O> => Promise.reject(new Error("model only: answered from a recording")),
  });

export const refundModel = setupAgent({
  input: z.object({ orderId: z.string() }),
  context: z.object({ /* what the control flow reads */ }),
  events: { APPROVE: {}, REJECT: {} },
  actors: {
    lookupOrder: placeholder(z.object({ orderId: z.string() }), orderSchema),
    decide: placeholder(z.object({ order: orderSchema }), decisionSchema),
    issueRefund: placeholder(z.object({ orderId: z.string(), amount: z.number() }), z.undefined()),
  },
}).createMachine({ /* states */ });
```

- One named actor per unit of work, invoked by `src`. Never inline actor logic in `invoke.src`: `checkConformance` rejects it, because it would run.
- A person's answer is an event the model waits for in an idle state.
- Each rule is a state or an inline guard: approval is the only way into the effect state, a cap is a counter checked in the transition that would exceed it.
- Import the code's constants (thresholds, caps) instead of copying them, so the model follows a change to them. When the code inlines a literal, can't be imported without running, or takes the value from a dependency that doesn't export it, copy it and add a test that reads the source file (or the dependency's built file) and fails when the literal changes.
- The `stately` skill can draft the model from the code. Review the draft against the code line by line: the proofs hold for the model only.

## 4. Proofs

For each rule, a `canReach` test with `reachable: false` **and** `complete: true`. The search forks only on the values in `outputs` and `payloads`, so the proof covers those values and no others: give each actor the outputs at each rule's boundary: just under, exactly at, and just over each threshold, and the cap reached. A guard written `>` where the rule means `>=` passes with only the values on either side. Say which values in the hand-back.

- **Non-vacuity:** for each rule, also show the guarded path exists, for example a large refund reached through approval is `reachable: true`. A proof over a path the model cannot take proves nothing.
- **Mutation check:** weaken one guard in a throwaway copy of the model and confirm the proof finds a witness. Delete the copy.
- Check `input` field names against the model's input schema.

## 5. Record runs

Write scenarios that drive the code with scripted stand-ins: one per rule, each boundary (under, at, and over each threshold), each exit (replied, refunded, declined, escalated, errors). Record each with `createRecorder` through the seam, and record the outcome with `recorder.output(...)`: the return value, or `{ threw: error.message }` when the code throws (see step 7). Run the code as it is. Save recordings as JSON fixtures when the stand-ins are slow or nondeterministic.

## 6. Map recorded calls to observations

Each recorder produces its own effect kind: `recorder.fn` and `recorder.client` give `kind: "call"` (`name`, `args`, `result`), `recorder.model` gives `kind: "model"` (`request`, `response`, `error`, `retriedBy`), `recorder.tools` gives `kind: "tool"` (`name`, `input`, `output`), and `recorder.output` gives `kind: "output"` (`value`). Map every kind your seam records. In a `model` effect, `response.content` is the provider's raw output: a tool call's `input` is a JSON string to parse.

```ts
const toObservations = (recording: Recording) =>
  recording.effects.flatMap((effect): Observation[] => {
    if (effect.kind === "output") return [{ kind: "returned", outcome: effect.value }];
    if (effect.kind !== "call") return []; // add cases for "model" and "tool" when the seam records them
    switch (effect.name) {
      case "decide": return [{ kind: "decision", decision: effect.result as Decision }];
      case "requestApproval": return [{ kind: "approval", approved: effect.result as boolean, amount: (effect.args as [{ amount: number }])[0].amount }];
      case "issueRefund": return [{ kind: "refund", ...(effect.args as [{ orderId: string; amount: number }])[0] }];
      default: return [{ kind: `unmapped:${effect.name}` }]; // a call the mapping does not know deviates
    }
  });
```

- The mapping reads only what each call shows: its name, arguments, and result.
- Never drop a call the mapping does not know. Map it to an observation no actor consumes, so a run that makes a new call deviates instead of conforming without it. Drop only effects the model has no step for, and list them in the hand-back.
- Never decide in the mapping what the code should do next, and never re-implement the code's logic there. A mapping that encodes the rules makes every run conform.

## 7. Conformance test

```ts
const report = await checkConformance(refundModel, {
  input: { orderId },
  observations: toObservations(recording),
  actors: {
    decide: { observes: "decision", output: ({ observation }) => observation.decision },
    issueRefund: {
      observes: "refund",
      matches: ({ input, observation }) => input.orderId === observation.orderId && input.amount === observation.amount,
    },
    save: {}, // the recording cannot see it
  },
  events: {
    approval: {
      event: (o) => ({ type: o.approved ? "APPROVE" : "REJECT" }),
      matches: ({ observation, context }) => observation.amount === (context as { amount: number }).amount,
    },
  },
  output: {
    observes: "returned",
    // Here the code returns a string ("refunded") and the model's output is { outcome: "refunded" }.
    // Compare the same values: unwrap whichever side wraps them, or compare whole objects by value.
    matches: ({ output, observation }) => (output as { outcome: string }).outcome === observation.outcome,
  },
});
expect(report.deviation).toBeUndefined();
```

- Give every model actor an entry. From alpha.42 the options are typed from the model: `actors` keys are its actor srcs, `observes` is an observation kind, and `observation` and `input` are narrowed to match, so use no `as never`. `input` takes the actor's input schema, so give each placeholder one; without it `input` is `unknown` and the callback needs a type annotation. An options object built outside the call needs `as const` on its `observes` values. An `output` the actor's output schema rejects is an `invalid-output` deviation, and an event payload the event schema rejects is `invalid-event`. `observes` names the observation kind it consumes; omit it for work the recording cannot see, and list those actors in the hand-back (`report.unobserved`).
- `matches` compares the actor's input with the observation. Compare every argument that identifies the work (the order and the amount refunded, the agent called), not only one: a refund to the wrong order with the right amount must deviate.
- When an actor's output carries state the recording does not show (a queue, a stack), build it in `output` from the model's own `input` plus the observation.
- `error` returns a value to fail the actor, for calls that threw in the recording.
- A deviation means the code or the model is wrong. Report it with `reason`, `expected`, `observed`, and `state`. Do not change the model to make a run conform without asking: the code may have the bug.
- Once you have confirmed a deviation is a finding about the code, keep the suite green by pinning it: the scenario's test asserts that exact deviation (`reason`, `state`, observed kind), with a comment that names the bug and says to remove the pin when the code is fixed. Never delete the scenario.
- An event entry `{ event, matches }` compares the observation with the model's `context` and `state`: the draft a person approved against the draft the model holds. A function entry compares nothing; list its payload as unchecked in the hand-back.
- `output` checks the code's return value: the model must finish there, and `matches` compares the outputs. Pass it for every run, including runs where the code threw: record the throw as the outcome (`recorder.output({ threw: error.message })` in the scenario's `catch`) and model each failure the code throws as a final state whose output `matches` compares. A model that errors instead of finishing leaves the outcome unconsumed, which deviates. Never leave `output` out to make a thrown run pass: the run would conform with its outcome unchecked. Without `output`, a recorded return value is an `extra-observations` deviation.

## 8. Coverage

Pass every report's `trace` to `traceCoverage` from `@statelyai/agent/evals`. For each unvisited state or handler, add a scenario that reaches it, or write down why production cannot reach it. Error paths are the usual gap. A gap behind a pinned deviation cannot be reached until the code is fixed: list it as blocked by that finding.

## 9. Bite check

Prove the check catches a real regression: copy the code to a throwaway file, introduce one plausible bug that breaks a rule (an off-by-one cap, a skipped approval), record the scenarios against the copy, and confirm at least one deviates at the step you expect. Delete the copy. Never edit the real file.

## Hand back

- Files added: the model, proofs, scenarios, mapping, and conformance test. The code under check is unchanged (`git diff` on it is empty), or changed only by the seam commit the user approved, named here.
- A table: each rule, proved or not (with depth), and how many recorded runs exercised it.
- Unobserved actors, other unchecked values (event payloads and return values no `matches` compares, arguments no `matches` compares), and coverage gaps, with what would close them.
- Findings: each pinned deviation, the bug it shows in the code, and the scenarios that show it.
- The bite check: the bug, the scenario that caught it, and the deviation.
- The claim, in these words, only when every rule's proof is `reachable: false` with `complete: true`: the model is proved over the listed values, and these recorded runs conform. Name the values in the same bullet (the outputs and payloads each proof searched, such as amounts 99, 100, 101): a proof covers those and no others. When some runs deviate: the model is proved over the listed values; N of M recorded runs conform; each other run deviates at the step named, with the finding it shows. When a proof finds a witness or does not complete, do not say the model is proved: name each rule that is not proved, with the witness or the reason the search stopped, and claim only the rules that are.
- Offer migration only if the user wants the rules enforced at runtime: hand off to `loop-to-machine`. The model is the target for its carves, not a finished machine: `loop-to-machine` wraps the workflow first, and each carved phase needs its own proofs.
