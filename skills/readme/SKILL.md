---
name: readme
description: Keep README files in sync with the repo using symbolic HTML comments. Use this skill whenever making a repo change that could affect documentation — code (exported APIs, configuration, examples, CLI commands, dependencies), repo structure (adding/removing/renaming files, directories, packages, or other sibling entries referenced by a listing comment), or metadata (package.json, manifests). Also use when authoring or editing README files to add or update symbolic comments. Trigger on any change — code or structural — that touches a construct referenced by an HTML comment in a markdown file.
---

# Symbolic README References

HTML comments in markdown files act as declarative queries over the codebase — they describe what the surrounding content *should* reflect. Example:

```markdown
## API

<!-- exported functions and their signatures from src/index.ts -->

| Function | Description |
| --- | --- |
| `createMachine(config)` | Creates a state machine |

## Installation

<!-- install command matching package.json#name -->

`npm install xstate`
```

A comment is a symbolic reference if it describes content derivable from source — references to files/modules, package metadata, code constructs, or consistency constraints (`consistent with`, `matching`, `derived from`). Purely editorial comments (`<!-- TODO: rewrite -->`) are not symbolic references.

References can be **path-qualified** (`exported functions from src/index.ts`) or **logical** (`all exported creator functions`, `public API of the state module`, `supported config options`). Resolve logical references by searching the codebase for constructs that match the description — don't require a filename.

## When you change the repo

1. **Scan** all non-gitignored markdown files for symbolic comments: `rg -l '<!--' --glob '*.md' .`
2. **Check relevance** — does your change affect the content each comment describes? For logical references, resolve them against the codebase first, then check if the changed file/symbol falls in that set.
3. **Regenerate** affected sections: read the referenced source, extract the described construct, format to match existing style, replace only the content below the comment. Preserve the comment itself.
4. **Preserve** surrounding prose and sections without comments.
5. **Backfill comments on unannotated READMEs** — if a README has no symbolic comments but contains sections that clearly describe the code you just changed (API tables, install commands, config lists, CLI usage), infer the symbolic reference and insert a comment above that section before regenerating. Only backfill sections actually affected by the current change; don't rewrite the whole README. If the inferred reference is ambiguous, flag it instead of guessing.

If a comment references something that no longer exists, flag it to the user rather than silently removing the section.

## When you author a README

Add a symbolic comment above any section that reflects the repo (code, structure, or metadata). Good comments are specific (`<!-- exported functions from src/index.ts -->` or `<!-- all exported creator functions -->` — not `<!-- API docs -->`), scoped to one concept, and reference logical constructs rather than line numbers. Prefer logical descriptions when the set spans multiple files or may move.

## Scope

Apply to all non-gitignored markdown files in the project tree — `README.md`, `packages/*/README.md`, `src/**/README.md`, `docs/**/*.md`, `CONTRIBUTING.md`, etc.
