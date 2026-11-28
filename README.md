# Stately.ai Skills

Stately Skills are Claude skills for keeping your code, docs, and diagrams in sync as a living source of truth, readable by humans and AI agents alike.

## Available skills

<!-- list of skills in skills/ directory, linking to each SKILL.md with its frontmatter description -->

- **[readme](skills/readme/SKILL.md)** - Keep README files in sync with the codebase using symbolic HTML comments.
- **[state-management](skills/state-management/SKILL.md)** - Model, review, and refactor application state so source state stays minimal, derived state is computed, and impossible states are not representable.
- **[stately](skills/stately/SKILL.md)** - Find implicit state machines in application code, model and check their behavior, and inspect or improve them in Stately. Use for /stately, hidden-state discovery, statechart or protocol analysis, safety/liveness/deadlock checks, app documentation, and visual behavior proposals in any framework.
- **[xstate-v5](skills/xstate-v5/SKILL.md)** - Design, implement, review, and migrate XState v5 statecharts in TypeScript using modern v5 patterns.
- **[xstate-v6](skills/xstate-v6/SKILL.md)** - Write, review, and migrate XState v6 machines by reading the docs that ship with the installed package.

Full documentation for the `stately` skill is in [skills/stately/README.md](skills/stately/README.md), synced from statelyai/viz with the skill. The other skills are documented by their `SKILL.md` files.

## Install

<!-- Claude Code plugin from .claude-plugin/plugin.json, .claude-plugin/marketplace.json and .mcp.json; Codex plugin from plugin.json and mcp.json -->

### Claude Code

This repository is a Claude Code plugin marketplace. Install the `stately` plugin:

```text
/plugin marketplace add statelyai/skills
/plugin install stately@stately
```

Then run `/mcp` and sign in to the `stately` server to save and open models in Stately. Invoke the skill with `/stately:stately`.

The plugin loads the `stately`, `xstate-v5` and `xstate-v6` skills, the hosted Stately MCP server (`https://mcp.stately.ai/mcp`), and the opt-in `stately-channel` Apply channel.

Claude Code does not update third-party marketplaces automatically unless you turn on auto-update for the `stately` marketplace in `/plugin`. To update by hand:

```text
/plugin marketplace update stately
/plugin update stately@stately
```

### Codex

Add this repository as a Codex plugin marketplace, install the `stately` plugin, and sign in to the hosted Stately MCP server:

```sh
codex plugin marketplace add statelyai/skills
codex plugin add stately@stately
codex mcp login stately
```

Invoke the skill with `$stately`. The plugin loads the skills in `skills/` and the hosted Stately MCP server. Checking runs locally without signing in; saving and opening models in Stately requires it.

To update:

```sh
codex plugin marketplace upgrade stately
codex plugin add stately@stately
```

### Other agents

Install the skills with [skills](https://github.com/vercel-labs/skills). This installs the skills only. To save and open models in Stately, add the MCP server `https://mcp.stately.ai/mcp` to your agent and sign in.

```sh
npx skills add statelyai/skills
```

To install one skill, name it:

```sh
npx skills add statelyai/skills --skill xstate-v6
```

Or copy the skill directory manually:

```sh
mkdir -p "$HOME/.agents/skills"
cp -R skills/stately "$HOME/.agents/skills/stately"
```

Copy the whole directory: `skills/stately/scripts/` holds the bundled checker.

## Contributing

The `stately` plugin and skill (`.claude-plugin/plugin.json`, `.mcp.json`, `plugin.json`, `mcp.json`, `assets/`, and `skills/stately/`) are synced from [statelyai/viz](https://github.com/statelyai/viz) by `pnpm skills:sync`. Make changes to those paths in statelyai/viz; edits made here are overwritten by the next sync. Issues are welcome here.

The Stately Agent skills in `plugins/stately-agent/` moved here from [statelyai/agent](https://github.com/statelyai/agent) and are edited here. They are unlisted: the marketplace does not offer the `stately-agent` plugin, and each skill sets `metadata.internal: true`. Keep their API names in step with the `@statelyai/agent` `next` branch.
