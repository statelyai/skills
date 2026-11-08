import { readConfig } from './engine/frontends/config.ts';

const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** Reviewed author scope is data, never executable configuration or inferred proof. */
export function parseCheckScope(input) {
  if (
    !record(input) ||
    Object.keys(input).some(
      (key) => !['bounds', 'assumptions', 'ruleDescriptions'].includes(key),
    ) ||
    !record(input.bounds) ||
    !Array.isArray(input.assumptions) ||
    input.assumptions.some(
      (value) => typeof value !== 'string' || !value || value.length > 4000,
    ) ||
    (input.ruleDescriptions !== undefined &&
      (!record(input.ruleDescriptions) ||
        Object.values(input.ruleDescriptions).some(
          (value) => typeof value !== 'string' || !value || value.length > 4000,
        )))
  )
    throw Error(
      'Scope JSON requires bounds:{}, assumptions:string[], and optional ruleDescriptions:{"kind:RuleName":string}.',
    );
  return input;
}

/** Every configured section, including the INVARIANT/PROPERTY rules the engine rewrites. */
function configuredModel(result) {
  const config = result.binding?.artifacts?.find(
    (item) => item.role === 'config',
  );
  if (typeof config?.content === 'string')
    try {
      return readConfig({ file: config.path, text: config.content }).sections;
    } catch {
      // An unreadable config is diagnosed elsewhere; fall back to the checker record.
    }
  return result.checker.bounds.configuredSections ?? [];
}

export function completeHumanReport(text, result) {
  const checker = result.checker;
  const counts = checker.stateCounts ?? {};
  const count = (outcome) =>
    result.rules.filter((rule) => rule.outcome === outcome).length;
  const scope = checker.bounds.domain;
  const sections = configuredModel(result);
  return [
    '# Check scope and evidence',
    '',
    `${checker.name}: ${checker.version}`,
    `Configured rules: ${count('holds')} hold; ${count('broken')} broken; ${count('not-checked')} not checked.`,
    `Exploration complete: ${checker.complete}. Distinct checked states: ${counts.distinct ?? 'unknown'}.`,
    `Chart budget: ${checker.bounds.chartStates}; rerun budget: ${checker.bounds.rerunStates}; wall-time limit: ${checker.bounds.timeoutSeconds === 0 ? 'disabled' : `${checker.bounds.timeoutSeconds}s`}.`,
    '',
    '## Domain bounds',
    '',
    scope
      ? '```json\n' + JSON.stringify(scope, null, 2) + '\n```'
      : 'No separate domain bounds were supplied. Inspect the exact specification/configuration; finite observed state counts do not establish an application-wide bound.',
    '',
    '## Assumptions and proof limits',
    '',
    ...checker.assumptions.map((assumption) => `- ${assumption}`),
    '- Fairness is defined by the supplied TLA+ specification; no additional fairness is inferred.',
    '- Native playback inspects checker evidence. Application replay has not run as part of this checking command; record actual application tests separately.',
    '',
    '## Rule outcomes',
    '',
    ...result.rules.map((rule) => `- ${rule.id}: ${rule.outcome}`),
    '',
    '## Configured model',
    '',
    '```text',
    ...sections.map((section) => `${section.key} ${section.tokens.join(' ')}`),
    '```',
    '',
    ...result.rules.flatMap((rule) =>
      rule.description
        ? [`${rule.name} (${rule.kind}): ${rule.description}`, '']
        : [],
    ),
    text,
  ].join('\n');
}
