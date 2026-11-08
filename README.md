# Stately.ai Skills

Stately Skills are Claude skills for keeping your code, docs, and diagrams in sync as a living source of truth, readable by humans and AI agents alike.

## Available skills

<!-- list of skills in skills/ directory, linking to each SKILL.md with its frontmatter description -->

- **[readme](skills/readme/SKILL.md)** - Keep README files in sync with the codebase using symbolic HTML comments.
- **[stately](skills/stately/SKILL.md)** - Find implicit state machines in application code, model and check their behavior, and inspect or improve them in Stately. Use for /stately, hidden-state discovery, statechart or protocol analysis, safety/liveness/deadlock checks, app documentation, and visual behavior proposals in any framework.
- **[xstate-v5](skills/xstate-v5/SKILL.md)** - Design, implement, review, and migrate XState v5 statecharts in TypeScript using modern v5 patterns.

## Install

<!-- Claude Code plugin from .claude-plugin/plugin.json, .claude-plugin/marketplace.json and .mcp.json -->

### Claude Code

This repository is a Claude Code plugin marketplace. Install the `stately` plugin:

```text
/plugin marketplace add statelyai/skills
/plugin install stately@stately
```

Then run `/mcp` and sign in to the `stately` server to save and open models in Stately. Invoke the skill with `/stately:stately`.

The plugin loads the `stately` and `xstate-v5` skills, the hosted Stately MCP server (`https://mcp.stately.ai/mcp`), and the opt-in `stately-channel` Apply channel.

### Codex and other agents

Install the skills with [skills](https://github.com/vercel-labs/skills):

```sh
npx skills add statelyai/skills
```

Or copy the skill directory manually:

```sh
mkdir -p "$HOME/.agents/skills"
cp -R skills/stately "$HOME/.agents/skills/stately"
```

Copy the whole directory: `skills/stately/scripts/` holds the bundled checker.

## Contributing

The `stately` plugin and skill (`.claude-plugin/plugin.json`, `.mcp.json`, `assets/`, and `skills/stately/`) are synced from [statelyai/viz](https://github.com/statelyai/viz) by `pnpm skills:sync`. Make changes to those paths in statelyai/viz; edits made here are overwritten by the next sync. Issues are welcome here.
