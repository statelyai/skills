# Understand and maintain an app

Use this workflow when someone asks what their application does, wants a feature
inventory, or wants existing Stately documentation updated after a code change.
The coding host reads source. Stately stores and displays the resulting estimates.

## First use

1. Discover the actual exposed tools. Call `get_stately_flow_guidance`, inspect
   the repository and tests, and read `statelyai.json` for a linked project.
2. Inventory capabilities by user task, including those without a stateful flow.
   Give each feature a summary, source citations, uncertainty, optional category
   and evidence-supported entry points. User stories are optional.
3. Save the inventory with `save_stately_models` and meaningful stateful flows.
   Use an inventory carrier model if the app has no stateful flows; label it as
   documentation, without inventing behavior. Honor project links and retain the
   returned IDs. If the tool is absent, keep the inventory as an artifact and
   report saving as pending. Never call missing tools or invent links.
4. Return the project Features URL, scope and gaps. The user reviews the inventory
   and chooses **Review changes → Save review baseline** before future updates.

## During ordinary coding work

1. Scope the read to the changed capability. Reuse saved IDs and results already
   in this task's context. Use `get_stately_spec` with `machineId` and `query` when the model is known,
   or `projectId` and `query` otherwise (a feature name or source path fragment).
   A machine may carry the whole project inventory; keep `query` on small reads. Read the
   full project inventory only for an app-wide audit, export, or an explicit
   inventory replacement. A scoped result does not establish full coverage.
2. Inspect current source and tests. Read only models whose flow, stories or
   acceptance criteria need changes. Reuse an unchanged graph already in context;
   when freshness needs checking, pass its `knownRevision` to
   `read_stately_model({ machineId, knownRevision })`. A match returns a short
   confirmation; a changed revision returns the current graph. After a conflict,
   reread and reconcile. Do not reuse results across connections or projects, or
   after losing the graph from context. Fetch flow guidance once per task,
   connection and scope, and reuse it while it remains in context. Fetch again
   after a scope/connection change or tool catalog refresh.
3. Update only affected summaries, entry points and citations. Use
   `save_stately_models` with `featuresMode: "merge"` to send changed features by
   stable name and preserve unrelated entries on the target machines. Omit
   `features` when the inventory did not change. Send `expectedRevision` for
   existing machines. The default `replace` mode requires the complete retained
   inventory; never use a scoped read as replacement input. On older deployments
   without merge/query/revision options, read the affected machine's full
   inventory before a replacement and preserve all its entries, or report the
   scoped update as pending. Preserve human-authored prose and confirmed or
   retired decisions. New authored entries remain drafts. Surface conflicting
   interpretations for review. Missing functionality is **possibly removed**;
   do not silently delete it or restore retired requirements.
   Background maintenance must not open a view. Saves return links without an
   editor attachment. Use `open_stately_editor` or `visualize_machine` only when
   the user asks to see the result. If a host lacks `read_stately_model`, reuse
   graph/revision data already in context or report the update pending. Do not
   open the editor as a workaround.
4. Save into the same project and existing models with current revision guards
   wherever the tool supports them. Reopen and reconcile conflicts. Never copy a
   proposal into a fresh estimate to manufacture a match. Use source snapshots
   and evidence according to [the native workflow](native-workflow.md).
5. Return added, changed and possibly removed items, application checks actually
   run, unknowns, and the Features link. Ask the user to refresh and **Review
   changes**. If the connection/project is unavailable, report the update as
   pending and retain a local artifact.

The review baseline compares saved documentation with a snapshot retained for
that account in that browser. It is not a code scan, shared approval, or runtime
verification. **Mark changes reviewed** advances that baseline only. Requirement
confirmation/retirement remains in Stories. Partial reads block baseline saves;
load remaining machines and resolve failures first.

## Browser-local projects

MCP cannot read or write IndexedDB. For maintenance, ask for exported XGraph
files before claiming to have read the existing inventory. Return updated
XGraph JSON with features in `data.statelyMcpModel.features` and authored spec
annotations in `data.statelySpec`. The user imports a copy, reconciles changes,
and saves it in the local project. Preserve the original until reconciliation.

## Repository instruction

Add this to the app repository's AGENTS.md or CLAUDE.md, naming the linked project:

> Before completing a user-visible change, read and update the affected Stately
> features, entry points and source citations. Update stories/acceptance criteria
> when intent changes and flows when behavior changes. Reuse saved IDs, preserve
> unrelated inventory entries and human decisions, and leave new entries as
> drafts. Report added/changed/possibly removed items, actual application checks
> and evidence gaps, then return the Features link for review. If Stately cannot
> be reached, report the documentation update as pending.

This is an instruction for future coding tasks. It installs no background watcher.

## Managed GitHub App updates

For automatic merge-triggered drafts, use the hosted project's **Automatic updates
from GitHub** setup when available. A project owner/admin installs the existing
Stately GitHub App on selected repositories and creates pairing instructions.
Merge the supplied projectId and maintenance.connectionCode into statelyai.json,
preserving other settings, and commit to the default branch. The one-time challenge
expires after 24 hours; it is not an API credential. After pairing, remove the code
and retain maintenance: {}. Never provision a project-edit key or AI secret for
this managed workflow. The CLI preserves pairing settings during config rewrites.

The service produces separate generated drafts with cited source and coverage
gaps. The Features page shows saved/proposed text and lets the user accept or reject
each feature with its related stories and prose flows. Acceptance saves managed
GitHub documentation, separate from authored model/spec data. Download is optional,
not a required coding-agent handoff. Accepted documentation survives disconnect.
CLI spec export/import remains scoped to authored specs; managed documentation uses
the shared project documentation API. Read both layers before a user-requested
reconciliation; apply the preservation and draft rules above. Do not imply the
bot has changed existing authored models, confirmed requirements or advanced a
review baseline. Source scans execute no application code or tests.

## Verification recipes and evidence

Acceptance criteria may contain `checks` with command arguments, user steps,
expected results, scope and an optional recorded run. Preserve these annotations
when updating matching criterion IDs. Keep old results when instructions change;
the Features page identifies outdated results. Removing a criterion also removes
its checks. An empty checks array explicitly removes that criterion's recipes.

For runtime evidence, use the target repository's verification runner and import
its report from Features. Viz includes `scripts/verification/run-check.mjs` and
[the verification workflow](../../../../../docs/editor/verification.md).
Source-derived observations never establish a runtime pass. Imported outcomes
are caller-reported. A matching documented source revision does not establish
freshness against the current repository or deployment.
