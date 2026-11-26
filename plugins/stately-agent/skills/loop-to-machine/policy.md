# A policy machine

A policy answers one decision of the environment. It is a `setupAgent` machine, so `describeMachine`, traces, and evals work on it, and `improve-machine` can change it one diff at a time.

- **Input:** the facts it reads, the options the environment offered, and the environment's prompt. **Output:** one event, from a final state.
- **It proposes; the environment disposes.** The environment's guards still judge whatever the policy returns, so the policy needs no copy of the rules to be safe. It may import the environment's schemas, types, constants, and exported guard functions to decide well, and nothing else from it.
- **Its first version reproduces the current behavior.** When it still asks the model, it passes the environment's `system`, `prompt`, and `metadata.facts` through unchanged, so the model sees what it saw before.
- **Declare `version`** and bump it on every change. Its `description` is the environment's goal with measurable success criteria; ask the user to confirm it.
- **Where it lives:** one file next to the environment (`policy.ts`, or `policy/` with its `CHANGELOG.md`), holding the machine, `policyDecider`, and `withPolicy`.

## What the environment exports

The event schemas and the facts schema, so the policy reuses them instead of redeclaring them. The `agent.decide` input passes the facts as `metadata: { facts }`. The facts must carry everything any decider reads: the policy's rules, and the adapter that turns a request into a call to your model (the ticket, the customer, the order's owner). A field the adapter needs and the facts lack changes what the model sees, so the policy no longer reproduces the current behavior.

```ts
// In the environment file (exported there):
// Everything a decider reads: the policy's rules, and the model adapter when the policy asks the model.
export const factsSchema = z.object({
  ticket: z.string(),
  customerId: z.string(),
  order: z.object({ orderId: z.string(), customerId: z.string(), amount: z.number(), refunded: z.boolean() }).nullable(),
  requestedAmount: z.number().nullable(),
});
export const deskEvents = {
  REFUND: z.object({ amount: z.number() }),
  ESCALATE: z.object({}),
  CLOSE: z.object({}),
};
```

## The policy

```ts
import { z } from "zod";
import { runAgent, setupAgent, type AgentDecisionExecutor, type AgentRequestExecutors } from "@statelyai/agent";
import { deskEvents, factsSchema } from "./desk.js";

/** One proposal: an environment event with its `type`. */
const proposalSchema = z.discriminatedUnion("type", [
  deskEvents.REFUND.extend({ type: z.literal("REFUND") }),
  deskEvents.ESCALATE.extend({ type: z.literal("ESCALATE") }),
  deskEvents.CLOSE.extend({ type: z.literal("CLOSE") }),
]);
type Proposal = z.infer<typeof proposalSchema>;

const policyInputSchema = z.object({
  facts: factsSchema,
  options: z.array(proposalSchema),
  // The environment's own prompt and messages, passed through so the model sees what it saw before.
  system: z.string().optional(),
  prompt: z.string().optional(),
  messages: z.array(z.unknown()).optional(),
});

const policySetup = setupAgent({
  input: policyInputSchema,
  context: z.object({
    facts: factsSchema,
    options: z.array(proposalSchema),
    system: z.string().optional(),
    prompt: z.string().optional(),
    messages: z.array(z.unknown()).optional(),
    chosen: proposalSchema.nullable(),
  }),
  output: proposalSchema,
  // Only the events the policy can propose, not every environment event.
  events: { REFUND: deskEvents.REFUND, ESCALATE: deskEvents.ESCALATE, CLOSE: deskEvents.CLOSE },
});

/** The offered options of one type, as `payloads` entries (`type` removed). */
const payloadsOf = (options: readonly Proposal[], type: Proposal["type"]) =>
  options.filter((option) => option.type === type).map(({ type: _type, ...payload }) => payload);

const offers = (options: readonly Proposal[], type: Proposal["type"]) =>
  options.some((option) => option.type === type);

export const policyMachine = policySetup.createMachine({
  id: "resolution-policy",
  version: "1",
  description: "Pick one offered resolution per ticket. Success: the desk's outcome matches the expected outcome.",
  context: ({ input }) => ({ ...input, chosen: null }),
  initial: "checking",
  states: {
    // A rule ported from the old code: an already-refunded order closes, no model call.
    checking: {
      type: "choice",
      choice: ({ context }) =>
        context.facts.order?.refunded && offers(context.options, "CLOSE")
          ? { target: "chosen", context: { chosen: { type: "CLOSE" as const } } }
          : { target: "asking" },
    },
    asking: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "decider",
          name: "pickResolution",
          system: context.system,
          prompt: context.prompt ?? `Facts: ${JSON.stringify(context.facts)}`,
          messages: context.messages,
          allowedEvents: ["REFUND", "ESCALATE", "CLOSE"],
          // Only what the environment offered; `[]` withholds a type.
          payloads: {
            REFUND: payloadsOf(context.options, "REFUND"),
            ESCALATE: payloadsOf(context.options, "ESCALATE"),
            CLOSE: payloadsOf(context.options, "CLOSE"),
          },
          // Same shape as the environment's request, so the model adapter reads the facts unchanged.
          metadata: { facts: context.facts },
        }),
        onError: { target: "gaveUp" },
      },
      on: {
        REFUND: ({ event }) => ({
          target: "chosen",
          context: { chosen: { type: "REFUND" as const, amount: event.amount } },
        }),
        ESCALATE: { target: "chosen", context: { chosen: { type: "ESCALATE" as const } } },
        CLOSE: { target: "chosen", context: { chosen: { type: "CLOSE" as const } } },
      },
    },
    chosen: { type: "final", output: ({ context }) => context.chosen! },
    gaveUp: { type: "final", output: { type: "ESCALATE" as const } },
  },
});

/**
 * Runs the policy as the environment's decider: one policy run per decision request. Its input
 * is the request's `metadata.facts`, offered events, `system`, `prompt`, and `messages`, parsed
 * by the policy's input schema. Returns the policy's output event with its model usage.
 */
export function policyDecider(executors: AgentRequestExecutors): AgentDecisionExecutor {
  return async (request, info) => {
    // The policy answers closed choices: the environment's agent.decide passes `payloads`.
    if (!request.options) throw new Error(`'${request.name}' is not a closed choice`);
    const result = await runAgent(policyMachine, {
      input: policyInputSchema.parse({
        facts: request.metadata?.facts,
        options: request.options.map((option) => option.event),
        system: request.system,
        prompt: request.prompt,
        messages: request.messages,
      }),
      executors,
      ...(info?.signal ? { signal: info.signal } : {}),
    });
    if (result.status !== "done") throw new Error(`policy settled '${result.status}'`);
    // Report the policy's model usage so the environment's run counts it.
    const { modelCalls, ...usage } = result.usage;
    return { event: result.output, ...(modelCalls > 0 ? { usage } : {}) };
  };
}
```

- Every state that invokes `agent.decide` needs an `onError`, or `lintAgentMachine` warns. A policy that cannot choose falls back to the safest event the environment always accepts (here `ESCALATE`).
- A rule the policy applies without a model is a `choice` state over the facts, checked against what was offered (`offers`), since the environment may have withheld it.
- The policy needs the environment's decision to be a closed choice (`payloads` on its `agent.decide`). An open request has no `options`, and offering the policy `[]` would withhold every event and send each request to `gaveUp`, so the decider throws instead.
- With a `store`, give each decision's policy run its own `threadId` from `info.callKey` plus a hash of the policy input: `policy:${info.callKey}:${sha256(JSON.stringify(input))}`. A thread that already has entries is resumed, so a shared one returns an earlier choice, and a different input on it throws `thread-input-mismatch` (a version bridge keeps the call key and can change the request).

## Running it as the environment's decider

```ts
/** The model's executors, with the policy answering the environment's `chooseResolution`. */
export function withPolicy(modelExecutors: AgentRequestExecutors): AgentRequestExecutors {
  const decideWithPolicy = policyDecider(modelExecutors);
  return {
    ...modelExecutors,
    decide: (request, info) => {
      if (request.name === "chooseResolution") return decideWithPolicy(request, info);
      if (!modelExecutors.decide) throw new Error("no decide executor");
      return modelExecutors.decide(request, info);
    },
  };
}
```

Pass `withPolicy(modelExecutors)` as the environment's `executors` in the runner. That one line is the only runner change a policy needs. Decisions with any other name still reach the model.

A runner that already takes a decide executor for the decision (`runMachine({ decide })`) needs no routing: pass `policyDecider(modelExecutors)` there. If your model is not an executor (a function that returns an option index, say), wrap it in a decide executor first, the same adapter the runner uses, and keep that adapter out of the environment's imports.
