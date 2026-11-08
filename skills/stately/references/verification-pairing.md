# Pair with a project verification skill

Stately replaces `/statechart` as the entrypoint for TLA+ checking, native review,
raw-variable failure replay, and rechecking. It also models application behavior
and handles implementation proposals. It does not require pstack.

Lauren Tan's [create-formal-verification-skill](https://github.com/cursor/plugins/tree/main/pstack/skills/create-formal-verification-skill)
can still discover the highest-risk code and generate a durable project-local
verification workflow. Useful user request:

```text
/create-formal-verification-skill for this project. Use /stately as the TLA+
checking and reporting backend instead of /statechart. Keep the project's
existing language and use its appropriate verifier for non-TLA proofs.
```

When updating a generated skill, replace its `/statechart` invocation with the
installed Stately entrypoint; retain its actual model, invariants, harness,
proof assumptions, source mappings, and maintenance requirements. For example:

```sh
sh /path/to/installed/stately/scripts/stately-check check verification/Flow.tla --config verification/Flow.cfg --view verification/Flow.view.mjs --out NEW_RUN_DIR --source src/flow.ts --json
```

Publish the resulting bounded native view with `save_stately_check_result` and
record real application replay separately. Keep the original complete artifacts.
A generated skill can invoke `/stately` directly; it need not install `/statechart`
or depend on a pstack cache path.

The companion [maintain-formal-verification-skill](https://github.com/cursor/plugins/tree/main/pstack/skills/maintain-formal-verification-skill)
can maintain the project's proof workflow after source changes. Point its TLA+
check step at Stately too. For SMT, Lean, Dafny, Alloy, or another proof backend,
keep that verifier and its proof obligations authoritative. A Stately behavioral
model can explain the scope; it does not replace a different backend's proof.

The bundled TLC checking/projection engine is adapted from Lauren Tan's
MIT-licensed pstack implementation at a pinned commit. Attribution and local
adaptations ship in `scripts/engine/NOTICE.md` and `LICENSE.md`. Stately owns the
runner, toolchain bootstrap, native report/projection, editor workflow, and
regression coverage. The upstream plugin is not a runtime dependency.
