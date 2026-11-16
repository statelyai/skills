# Stately.ai Skills

Stately Skills are Claude skills for keeping your code, docs, and diagrams in sync as a living source of truth, readable by humans and AI agents alike.

## Available skills

<!-- list of skills in skills/ directory, linking to each SKILL.md with its frontmatter description -->

- **[readme](skills/readme/SKILL.md)** - Keep README files in sync with the codebase using symbolic HTML comments.
- **[stately](skills/stately/SKILL.md)** - Find implicit state machines in application code, model and check their behavior, and inspect or improve them in Stately. Use for /stately, hidden-state discovery, statechart or protocol analysis, safety/liveness/deadlock checks, app documentation, and visual behavior proposals in any framework.
- **[xstate-v5](skills/xstate-v5/SKILL.md)** - Design, implement, review, and migrate XState v5 statecharts in TypeScript using modern v5 patterns.

### Stately Agent skills

The `stately-agent` plugin holds skills for [`@statelyai/agent`](https://github.com/statelyai/agent) 2.0 alpha. Run the steps in order: each needs the one before it.

| Step | Skill | What it does |
| --- | --- | --- |
| Route | [graph-engineering](plugins/stately-agent/skills/graph-engineering/SKILL.md) | Finds which step a project is at and loads the next skill |
| 0. Verify in place | [verify-in-place](plugins/stately-agent/skills/verify-in-place/SKILL.md) | Models existing code, proves the model's rules, and checks recorded runs of the unchanged code with `checkConformance` |
| 1. Make it a machine | [loop-to-machine](plugins/stately-agent/skills/loop-to-machine/SKILL.md) | Converts existing agent code into a machine and checks parity with `compareRuns` |
| 1. Make it a machine | [build-machine](plugins/stately-agent/skills/build-machine/SKILL.md) | Builds a TypeScript machine from a spec and proves its invariants |
| 1. Make it a machine | [generate-machine](plugins/stately-agent/skills/generate-machine/SKILL.md) | Authors a JSON policy machine and runs `verifyAgentConfig` |
| 2. Add traces | [add-traces](plugins/stately-agent/skills/add-traces/SKILL.md) | Stamps and persists every run so it replays |
| 3. Add evals | [add-evals](plugins/stately-agent/skills/add-evals/SKILL.md) | Writes evals per state, at the cheapest level that catches the failure |
| 4. Improve (experimental) | [improve-machine](plugins/stately-agent/skills/improve-machine/SKILL.md) | Improves a policy from traces; a person reviews the pull request |

The skills track the `@statelyai/agent` [`next` branch](https://github.com/statelyai/agent/tree/next). APIs change between alphas, so check the package's `CHANGELOG.md` when a call does not match.

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

For the Stately Agent skills, install the `stately-agent` plugin:

```text
/plugin install stately-agent@stately
```

### Codex and other agents

Install the skills with [skills](https://github.com/vercel-labs/skills):

```sh
npx skills add statelyai/skills
```

To install one skill, name it:

```sh
npx skills add statelyai/skills --skill loop-to-machine
```

Or copy the skill directory manually:

```sh
mkdir -p "$HOME/.agents/skills"
cp -R skills/stately "$HOME/.agents/skills/stately"
```

Copy the whole directory: `skills/stately/scripts/` holds the bundled checker.

## Contributing

The `stately` plugin and skill (`.claude-plugin/plugin.json`, `.mcp.json`, `assets/`, and `skills/stately/`) are synced from [statelyai/viz](https://github.com/statelyai/viz) by `pnpm skills:sync`. Make changes to those paths in statelyai/viz; edits made here are overwritten by the next sync. Issues are welcome here.

The Stately Agent skills in `plugins/stately-agent/` moved here from [statelyai/agent](https://github.com/statelyai/agent) and are edited here. Keep their API names in step with the `@statelyai/agent` `next` branch.
