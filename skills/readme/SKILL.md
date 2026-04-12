---
name: readme-ref
description: Keep README files in sync with the codebase using symbolic HTML comments. Use this skill whenever modifying code that could affect documentation — exported APIs, configuration, examples, CLI commands, dependencies, or any construct referenced by an HTML comment in a markdown file. Also use when authoring or editing README files to add or update symbolic comments. Trigger on any code change that touches public interfaces, package metadata, or files referenced by README comments.
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

## When you change code

1. **Scan** all markdown files for symbolic comments: `grep -rl '<!--' --include='*.md' .`
2. **Check relevance** — does your change affect the content each comment describes?
3. **Regenerate** affected sections: read the referenced source, extract the described construct, format to match existing style, replace only the content below the comment. Preserve the comment itself.
4. **Preserve** surrounding prose and sections without comments.

If a comment references something that no longer exists, flag it to the user rather than silently removing the section.

## When you author a README

Add a symbolic comment above any section that reflects code. Good comments are specific (`<!-- exported functions from src/index.ts -->` not `<!-- API docs -->`), scoped to one concept, and reference logical constructs rather than line numbers.

## Scope

Apply to all markdown files in the full project tree — `README.md`, `packages/*/README.md`, `src/**/README.md`, `docs/**/*.md`, `CONTRIBUTING.md`, etc.
