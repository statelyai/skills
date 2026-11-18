# Review a change for state bugs

Use this when the request is a diff, branch, commit range, or pull request:
"review this PR for state bugs", "what can this change break", or a review
before merge. The goal is to report state bugs that the change introduces or
makes reachable, with replayable evidence, at the cost of one focused pass.

Line-by-line review checks whether each changed line is right. A state bug
needs a different question: what happens to a state on every path, including
paths the diff does not touch. The upload button below has no wrong line:

```ts
setUploading(true);
const url = await getUploadUrl(file);
if (!url) return; // added by the change
await put(url, file);
setUploading(false);
```

The added early return is a new exit from "uploading" that never resets it,
so the button stays disabled until reload when the server returns no URL.

## Steps

1. **Get the change.** Resolve the base with `git merge-base` and read the diff
   between it and the head. For a PR, fetch its base and head commits. Read
   the PR description and linked issue for the intended behavior.
2. **List leads and pick the profile.** Run the lead scanner from the
   repository root:

   ```sh
   node SKILL_DIR/scripts/state-leads.mjs --base BASE --head HEAD
   ```

   Its first line recommends a profile. Follow it unless the user asked for
   one:

   - `none`: the diff changes no executable code (docs, comments, lock files,
     images). Report that no state surface changed and stop.
   - `single`: one pass, as below.
   - `thorough`: the diff touches persistence, a store, a queue, payments,
     sync, a cache, a lock, or work it no longer awaits. Run two independent
     passes and a separate merge-and-verify step, as in [Cost](#cost).

   Review every changed code file in either pass; do not skip a file because
   it looks unrelated to state. The scanner also prints changed code lines
   with signal tags, every writer and reader of each state value the diff
   touches, exit-parity hints such as an early return between `setX(true)`
   and `setX(false)`, removed guards and resets, and work the change stops
   awaiting. Treat the output as a lead list and a lookup table, not as
   findings. Add leads it cannot see: a new
   enum member, a changed persisted shape, an event the change starts sending,
   a call the change reorders. When the scanner cannot run, build the same
   list with `git grep -n -w` on each touched state value.
3. **Check each lead against every kind.** Open the enclosing function and
   the sites the lookup lists, then apply each kind in
   [state-bugs.md](state-bugs.md#kinds) that fits the lead. Run exit, sibling,
   pair, inverse, new-path, case, and client parity from
   [Find absences](state-bugs.md#find-absences) for every lead that sets a
   value, writes stored state, adds a state, or adds a path that repeats an
   existing operation.
   Follow a lead into unchanged code as far as the sequence needs; the bug
   is often in a path the diff did not touch.
4. **Close the ledger.** Mark each lead as a finding, a question, cleared
   with the deciding line you read, or not checked with a reason, as in
   [The lead ledger](state-bugs.md#the-lead-ledger).
5. **Verify.** Re-trace each finding from its cited lines, as in
   [Verify before reporting](state-bugs.md#verify-before-reporting). Drop the
   ones that fail. Audit the clears the same way and reopen any whose cited
   line does not block the sequence.
6. **Report.** See [Report](#report).

## Scope of a finding

Report a finding when the change introduces it, makes it reachable, or makes
it worse: a new exit, a removed guard, a new state, a new caller of an
unguarded transition, a new concurrent path, or a new persisted field. A
pre-existing bug that the changed lines touch goes in a separate short list
marked pre-existing. Do not sweep the repository for unrelated state bugs;
offer [implicit-machines.md](implicit-machines.md) for that.

Report only state bugs. Before reporting a finding, apply the test in
[state-bugs.md](state-bugs.md): if a single call with fresh state fails the
same way, it is not a state bug. Put real defects that fail this test under
**Other defects**, one line each with `path:line`, after the ledger.

## Cost

One pass with the whole kind list per lead costs less than one reviewer per
kind, because each reviewer would read the same code again. Keep the pass
narrow instead:

- Read the diff, the enclosing functions, and the sites the lookup lists.
  Read more only to complete a sequence.
- Reuse the lookup output; do not repeat its searches.
- Delegate only when the diff is large. Split by owner (a module, service, or
  state value cluster), never by kind, and give each delegate the diff hunks
  for its owner, the lookup rows, and this file. Each delegate returns its
  ledger. A diff of up to about 600 changed code lines or 15 leads fits one
  pass.
- Verification reads only the cited lines. A cheaper model can verify when
  the host offers one, because the finding carries its own sequence.
- When the scanner recommends `thorough`, a miss is expensive, or the user asks
  for a thorough review, run a second independent pass with a fresh
  context, merge the two ledgers, and give the merged ledger to a separate
  verifier. Single passes vary, and in the benchmark the union of passes found
  more bugs than any one pass.

## Report

Start with one line: how many leads were checked, how many findings
survived verification, and how many were dropped.

For each finding, most consequential first:

```text
[kind] state: <phase or combination>
event: <trigger>
1. <entry point> (path:line)
2. ...
n. <acting line> (path:line): <what it does without the check>
consequence: <what the user or data ends up with>
introduced by: <diff line or "pre-existing">
fix: <smallest change, such as moving the reset into finally>
test: <sketch, not run>
```

### Test sketch

Give each finding a test sketch in the repository's own test runner and
style; copy the setup from an existing test of the same module. Each numbered
step becomes one arrange or act line, and the assertion states that the
consequence does not happen (the button is enabled again, the receipt is sent
once). Mark it `sketch, not run`. Run it only when the user asks; a sketch that
passes against the head means the finding is wrong, as in
[Verify before reporting](state-bugs.md#verify-before-reporting). When the
repository has no tests for the module, describe the sequence as a manual
reproduction instead.

### Bug path diagram

For each high-consequence finding, at most three, build the affected flow as an
XState v6 config: the states the finding names, one event per step of its
sequence (prefix the description with the step number), and the state where it
goes wrong, colored with `"meta": { "@statelyai.color": "red" }` and described
with the fix. A stuck state is a self-transition on the
event that has no exit. Keep the flow to what the finding touches. Show it with
`visualize_machine({ format: "xstate", machine: config })` and put the returned
link next to the finding, labeled estimated from source.

```json
{
  "id": "upload",
  "initial": "idle",
  "states": {
    "idle": { "on": { "PICK_FILE": { "target": "uploading", "description": "1. user picks a file" } } },
    "uploading": {
      "meta": { "@statelyai.color": "red" },
      "description": "Bug: no exit when the server returns no URL; the button stays disabled. Fix: reset in finally.",
      "on": {
        "UPLOADED": { "target": "idle" },
        "NO_URL": { "target": "uploading", "description": "2. early return skips the reset (bug)" }
      }
    }
  }
}
```

When the user asks to see the path on the diagram and a Stately connection is
signed in, save the flow with `save_stately_models` as an estimated model and
open it with `open_stately_editor`, passing the sequence's events as a
`session.highlights` scenario. Without a connection, give the config itself so
the user can import it. A diagram never replaces the numbered sequence.

A comment posted to a pull request carries the Stately link and, beside it, the
same flow as a Mermaid `stateDiagram-v2`, because reviewers may lack access to
the project and GitHub renders Mermaid inline. Mark the bad state with
`classDef breaks fill:#fdd,stroke:#c00` and `class <state> breaks`.

Then each question in the same format, with the unconfirmed step marked
`assumed`. Questions are part of the review: a reviewer can confirm one step
faster than find the bug.

Then the ledger as a table: lead, kinds checked, result (finding, question,
cleared, or not checked), and the deciding `path:line`. Keep cleared rows to
one line each.

When posting to a PR, post each finding and question as an inline comment on
its acting line or its introducing diff line, with the sequence, the test
sketch, and the diagram link plus its Mermaid when there is one. Label questions as questions. Ask before posting; a
review comment is outward-facing.

## Make it explicit

When a finding comes from flags that encode one lifecycle, offer the smallest
change that makes the states explicit in the existing framework: a
discriminated union, a reducer, or a statechart. For a consequential finding,
offer to model the sequence and check it, then replay the counterexample as a
test, as in [Verify before reporting](state-bugs.md#verify-before-reporting).
