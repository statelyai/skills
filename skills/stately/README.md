# Stately skill

The `stately` skill teaches coding agents to find the implicit state machines in
your code, review changes for state bugs, model-check flows, and make flags
explicit as XState machines. It works with any language and framework.

This README is the skill's documentation. It lives next to `SKILL.md` and ships
with every copy of the skill.

## Install

Install the skill with [skills](https://github.com/vercel-labs/skills), which
works with Claude Code, Codex, Cursor, OpenCode, and other coding agents:

```bash
npx skills add statelyai/skills --skill stately
```

In Claude Code, you can also install it as a plugin. The plugin includes the
`stately`, `xstate-v5`, and `xstate-v6` skills and connects the Stately MCP
server:

```text
/plugin marketplace add statelyai/skills
/plugin install stately@stately
```

In Codex, install the same plugin from the command line, then sign in to the
Stately MCP server:

```bash
codex plugin marketplace add statelyai/skills
codex plugin add stately@stately
codex mcp login stately
```

`npx skills add` installs the skill files only. To connect the MCP server in an
agent installed that way, see [MCP](https://stately.ai/docs/packages/mcp).

To update the plugin in Claude Code, run `/plugin marketplace update stately`,
then `/plugin update stately@stately`. To update it in Codex, run
`codex plugin marketplace upgrade stately`, then
`codex plugin add stately@stately`.

For a manual first install, copy the whole `skills/stately` directory from a
statelyai/skills checkout. `scripts/` holds the bundled checker. Back up local
edits before updating an existing installation.

```sh
test -d skills/stately &&
  mkdir -p "$HOME/.agents/skills" &&
  mkdir "$HOME/.agents/skills/stately" &&
  cp -R skills/stately/. "$HOME/.agents/skills/stately/"
```

To save and open models in Stately, connect the agent to the MCP server at
`https://mcp.stately.ai/mcp` and sign in. See
[MCP](https://stately.ai/docs/packages/mcp) for each agent's setup. In Claude
Code, run `/mcp` and sign in to `stately`. In Codex, run
`codex mcp login stately`.

## Use

Mention Stately in a request to use the skill, as in the examples below. You
can also invoke it with `/stately:stately` in Claude Code (or `/stately` where
the host exposes the short name) or `$stately` in Codex.
Finding, reviewing, and checking need no XState, no Stately account, and no MCP
connection, and they never edit your code. With a connection, each diagram
comes with a link to view it in Stately. Links to unsaved diagrams from
`mcp.stately.ai` expire after 30 days; save a model to keep it. Without a connection, the skill gives
diagrams as XState configs that you can import into Stately.

### Find implicit state machines

```text
Use Stately to find all of the implicit state machines in my app.
```

An implicit state machine is state that the code tracks with separate flags,
status strings, nullable fields, and timers instead of one explicit state. For
example, `isLoading`, `error`, and `data` in one component form a state machine
whose states are not written down, and nothing prevents `isLoading` and `error`
from both being set.

The skill reads the code area by area and lists each candidate with:

- the values and events that make up the machine, cited with `path:line`
- a transition table
- the bug each one allows, if any, ranked by consequence
- a Stately diagram

When the agent can write files, it keeps the list in an inventory document and
updates it on later runs. If it covers only part of a large repository, it says
which areas remain. See the
[discovery workflow](references/implicit-machines.md).

### Review a change for state bugs

```text
Use Stately to review this PR for state bugs.
```

A bundled scanner reads the diff and lists leads: values that a change writes or
reads, exits that skip cleanup, removed guards, and work that is no longer
awaited. It also picks a review depth:

| Profile  | When                                                                                                          | What runs                                                                                                                              |
| -------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| None     | The diff changes no executable code (docs, comments, lock files, images)                                      | No review                                                                                                                              |
| Single   | Most changes                                                                                                  | One pass over every changed code file                                                                                                  |
| Thorough | The diff touches persistence, a store, a queue, payments, sync, a cache, a lock, or work it no longer awaits | Two independent passes, then a separate pass that merges them, re-traces each finding, and audits every lead that was cleared |

Each lead is checked against twelve kinds of state bug, including stuck states,
event ordering, check-then-act races, stale copies, retries and timers, and
error paths. Each finding includes the state, the event, the numbered sequence
of `path:line` steps that reaches it, the consequence, and a test sketch. The
skill asks before posting review comments. See the
[review workflow](references/state-review.md).

### Check a flow

```text
Use Stately to check that the checkout flow never charges an order twice, and that
every started payment eventually settles or fails.
```

The skill models the flow from the code, writes the rules, and runs a bundled
model checker. A model checker explores every sequence of events within the
model's bounds, so it finds bugs that only appear after a specific order of
events. Where the code can run concurrently (two tabs, two requests, or a retry
that overlaps the first attempt), the model includes at least two callers.

Each rule gets one of three verdicts:

- **holds**: the rule is true for every behavior of the model within its
  bounds. For a safety rule, no reachable state violates it. For a liveness
  rule, every path eventually satisfies it.
- **broken**: the checker found a counterexample. For a safety rule, it is a
  path of events from the initial state to the violation. For a liveness rule,
  it is a path that ends in a cycle that repeats forever, or in a state where
  the machine stays forever, without satisfying the rule, such as a retry loop
  that never settles.
- **not checked**: the checker could not decide, for example because
  exploration hit its state limit or a guard could not be resolved.

The skill replays counterexamples against your application where your tests
allow, and reports model results, source findings, and application test results
separately. A rule that holds in the model is not proof that the application
behaves the same way.

Hosts that cannot run commands need a Stately MCP connection that exposes the
`check_machine` tool. It runs the native checker hosted, with limits of 20000
states and 10 s, and cannot run TLA+ specs.

### Check a fix

```text
Use Stately to check whether my change fixes the double charge.
```

The skill reruns the same rules, bounds, and payloads on the fixed model and
compares the two runs with `stately-check compare BEFORE_RUN AFTER_RUN`. Each
rule is reported as fixed, still broken, broken by the fix, or not checked. It
replays the original counterexample on the fixed model and in the application.

### Formal verification and TLA+

By default, the skill checks the statechart with a native checker. The native
checker explores every reachable configuration of the machine under XState v6
semantics, including nested and parallel states, eventless transitions, and
delays. It needs no Java and no TLA+. On first use, it downloads XState (about
0.4 MB) and verifies its checksums.

The skill writes the rules in a rules file next to the model. The rules file
also gives each context variable a finite domain, each guard and action an
expression, and each event its possible payloads. Rules have one of these kinds:

| Kind                | Meaning                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------- |
| `never`             | No reachable state satisfies the condition (a safety rule).                              |
| `initially`         | Every initial state satisfies the condition.                                             |
| `reachable`         | Some reachable state satisfies the condition.                                            |
| `eventually`        | Every behavior reaches a state where the condition holds (a liveness rule).             |
| `eventually-always` | Every behavior reaches a point after which the condition always holds.                  |
| `leads-to`          | Every state that satisfies one condition is followed by a state that satisfies another. |
| `no-dead-ends`      | Every reachable state has a next step. Final states are allowed by default.             |

Liveness rules can declare weak fairness for an event: if the event stays
enabled in every state of a cycle, the cycle must eventually take it. Weak
fairness does not force an event that is enabled only some of the time. Each
guard and action can cite the code it came from. The report lists conditions
without a citation, and the skill reports a rule as holding only in the model
until those conditions are confirmed. See
[native checking](references/native-checking.md).

The skill uses [TLA+](https://lamport.azurewebsites.net/tla/tla.html) with the
TLC model checker instead when:

- you give it a `.tla` file or ask for TLA+
- the state includes sets or maps, such as a set of prepared participants
- the model needs model-value constants or symmetry
- a property needs strong fairness or a temporal formula beyond the rule kinds
  above
- the data needs bounds set by model constants or state constraints instead of
  a fixed list of values

TLC also explores a finite state space. When the code has unbounded data, such
as a retry counter with no limit, the skill checks a bounded version and reports
the bounds with each verdict. A rule that holds within those bounds is not a
proof for every value.

For TLA+, the skill writes the spec, a TLC config, and a view that projects
TLC's states onto a statechart, so counterexamples show up in Stately like
native ones. It uses Java 11 or later when installed, or downloads a Java
runtime and TLC 1.7.4 on first use, with checksums verified. To check an
existing spec:

```text
Use Stately to check verification/Flow.tla.
```

The skill can also import a TLC JSON trace (`-dumpTrace json`) or DOT state
graph (`-dump dot`) from an earlier run, keeping its original provenance. See
[TLA+ checking](references/formal-checking.md).

To run the checker without an agent:

```sh
sh /path/to/stately/scripts/stately-check check verification/Flow.json --rules verification/Flow.rules.json --out NEW_RUN_DIR --json
sh /path/to/stately/scripts/stately-check check verification/Flow.tla --config verification/Flow.cfg --view verification/Flow.view.mjs --out NEW_RUN_DIR --json
```

To keep a durable verification workflow in a project, pair the skill with Lauren
Tan's
[create-formal-verification-skill](https://github.com/cursor/plugins/tree/main/pstack/skills/create-formal-verification-skill).
Ask it to use the Stately skill as its TLA+ checking and reporting backend. For
other proof tools such as Lean, Dafny, or Alloy, keep that tool's proofs
authoritative. A Stately model describes their scope, not their proof. See
[pairing instructions](references/verification-pairing.md).

The TLA+ engine is adapted from Lauren Tan's MIT-licensed `/statechart` skill.
It never reads an installed pstack plugin or requires one at runtime.

### Make a machine explicit

```text
Use Stately to make the upload flags explicit.
```

The skill writes tests for the current behavior first, then replaces the flags
with an XState machine and deletes the flags it replaces. It uses XState v6 beta
by default, or XState v5 when the project already depends on it. It checks the
new machine against the same rules and runs the test suite. This is the only
request that changes your code. See
[Make a machine explicit](references/implicit-machines.md#make-a-machine-explicit).

### Model a flow in Stately

```text
Use Stately to model the checkout flow in this repository and show it in Stately.
```

The skill saves one machine per flow, with each state and transition linked to
the code it came from, and returns a link to the editor. This request needs the
MCP connection and sign-in. Viewing saved models requires access to their
project. For a first feature inventory, ask `Use Stately to help me understand
this app`. See the
[app-understanding workflow](references/app-understanding.md).

## Runtimes

The checker runs with Node 22.18 or later (23.6 or later on Node 23), Bun 1.1.5
or later, or Deno 2 or later, on macOS, Linux, and Windows. Windows uses the
adjacent `stately-check.ps1` launcher. `--offline`, `JAVA`, and `TLA2TOOLS` use
existing or cached installations. See the
[compatibility contract](references/compatibility.md).

## Troubleshooting

If several Stately connections are available, the skill reads and rechecks a
saved model through one that can access it. A `forbidden` response from one
connection does not mean every connected account lacks access, so the skill
tries the other connected servers read-only before reporting an access failure.

If the optional `stately-channel` server times out while connecting, the local
`npx` cache entry for `@statelyai/mcp` may be incomplete (a `node_modules`
directory without a `package.json`, which can happen when several sessions
install it at once). Run `npx -y @statelyai/mcp@0.26.1 channel` in a terminal to
see the error, remove the directory it names under `~/.npm/_npx`, and
reconnect. The hosted `stately` server is unaffected.

## Self-hosting

Finding, reviewing, and checking need no server. A self-hosted deployment
exposes its MCP endpoint at `/api/mcp`. See
[Conversion API and MCP](https://stately.ai/docs/self-hosting#conversion-api-and-mcp)
for its tools and for bridging stdio-only clients.
