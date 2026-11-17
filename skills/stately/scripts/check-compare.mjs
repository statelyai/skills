// `stately-check compare BEFORE_RUN AFTER_RUN`: rule-by-rule comparison of two check
// runs (their check-report.json), for confirming that a model fix removed a bug.
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

const readJson = async (file) => JSON.parse(await readFile(file, 'utf8'));
const optionalJson = (file) =>
  readJson(file).catch((error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  });
const stable = (value) =>
  Array.isArray(value)
    ? value.map(stable)
    : value && typeof value === 'object'
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((key) => [key, stable(value[key])]),
        )
      : value;
const same = (left, right) =>
  JSON.stringify(stable(left)) === JSON.stringify(stable(right));

async function readRun(path) {
  const directory = (await stat(path)).isDirectory();
  const reportPath = directory ? join(path, 'check-report.json') : path;
  const report = await readJson(reportPath);
  if (report?.schemaVersion !== 'stately.check-report.v1')
    throw Error(`${reportPath} is not a stately.check-report.v1 check report.`);
  // Native runs keep their rules file in inputs/ and as an attached document.
  const document = report.documents?.find((item) => item.path === 'inputs/rules.json');
  const rulesFile =
    (directory ? await optionalJson(join(path, 'inputs', 'rules.json')) : undefined) ??
    (document ? JSON.parse(document.content) : undefined);
  // TLA+ runs carry the spec text in check-result.json, not in the report.
  const result = directory
    ? await optionalJson(join(path, 'check-result.json'))
    : undefined;
  const specs = (result?.binding?.artifacts ?? [])
    .filter((item) => item.role === 'spec')
    .map((item) => item.content);
  return { path, reportPath, report, rulesFile, specs };
}

/** A TLA+ definition's text with comments and whitespace removed. */
function tlaDefinition(specs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const head = new RegExp(`^${escaped}\\s*(\\([^)]*\\))?\\s*==`, 'm');
  for (const spec of specs) {
    const text = spec.replace(/\(\*[\s\S]*?\*\)/g, '').replace(/\\\*.*$/gm, '');
    const match = head.exec(text);
    if (!match) continue;
    const rest = text.slice(match.index + match[0].length);
    const end = rest.search(/^(?:[A-Za-z_]\w*\s*(?:\([^)]*\))?\s*==|-{4,}|={4,})/m);
    return (end < 0 ? rest : rest.slice(0, end)).replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

/** What a rule asserts, without its description. Native rules files only. */
const definition = ({ description, ...rule }) => rule;
const TLA_BOUND_SECTIONS = new Set([
  'CONSTANT',
  'CONSTANTS',
  'CONSTRAINT',
  'CONSTRAINTS',
  'ACTION_CONSTRAINT',
  'ACTION_CONSTRAINTS',
  'SYMMETRY',
  'VIEW',
]);
/**
 * The bounds a run explored under. Guards, actions and the model itself may change
 * between runs; that is the fix being compared.
 */
function modelBounds({ report, rulesFile }) {
  const bounds = report.checker.bounds ?? {};
  if (rulesFile)
    return {
      context: rulesFile.context ?? {},
      init: rulesFile.init ?? {},
      events: rulesFile.events ?? {},
      fairness: rulesFile.fairness ?? 'weak',
      bounds: {
        maxStates: rulesFile.bounds?.maxStates ?? 50_000,
        maxAlwaysSteps: rulesFile.bounds?.maxAlwaysSteps ?? 50,
        timeoutMs: rulesFile.bounds?.timeoutMs ?? 0,
      },
      scope: bounds.domain ?? {},
    };
  return {
    scope: bounds.domain ?? {},
    timeoutSeconds: bounds.timeoutSeconds,
    sections: (bounds.configuredSections ?? []).filter((section) =>
      TLA_BOUND_SECTIONS.has(section.key),
    ),
  };
}

function differences(before, after) {
  const reasons = [];
  if (before.report.checker.name !== after.report.checker.name)
    reasons.push(
      `The runs used different checkers: ${before.report.checker.name} and ${after.report.checker.name}.`,
    );
  const ids = (run) => run.report.rules.map((rule) => rule.id);
  const onlyBefore = ids(before).filter((id) => !ids(after).includes(id));
  const onlyAfter = ids(after).filter((id) => !ids(before).includes(id));
  if (onlyBefore.length || onlyAfter.length)
    reasons.push(
      `The runs checked different rule sets: ${[
        ...(onlyBefore.length ? [`only before: ${onlyBefore.join(', ')}`] : []),
        ...(onlyAfter.length ? [`only after: ${onlyAfter.join(', ')}`] : []),
      ].join('; ')}.`,
    );
  if (before.rulesFile && after.rulesFile) {
    const rules = (run) =>
      new Map(
        (run.rulesFile.rules ?? []).map((rule, index) => [
          rule.id ?? `rule_${index}`,
          definition(rule),
        ]),
      );
    const left = rules(before);
    const right = rules(after);
    const changed = [...left.keys()].filter(
      (id) => right.has(id) && !same(left.get(id), right.get(id)),
    );
    if (changed.length)
      reasons.push(`Rules changed between the runs: ${changed.join(', ')}.`);
  } else if (!before.rulesFile && !after.rulesFile) {
    // TLA+: compare each invariant or property definition in the spec text.
    const names = before.report.rules
      .filter((rule) => rule.kind !== 'deadlock')
      .map((rule) => rule.name ?? String(rule.id).replace(/^\w+:/, ''));
    const unknown = [];
    const changed = [];
    for (const name of names) {
      const left = tlaDefinition(before.specs, name);
      const right = tlaDefinition(after.specs, name);
      if (left === undefined || right === undefined) unknown.push(name);
      else if (left !== right) changed.push(name);
    }
    if (changed.length)
      reasons.push(`Rules changed between the runs: ${changed.join(', ')}.`);
    if (unknown.length)
      reasons.push(
        `Rule definitions could not be read from both runs' specs, so a changed rule cannot be ruled out: ${unknown.join(', ')}. Pass run directories that contain check-result.json.`,
      );
  }
  const leftBounds = modelBounds(before);
  const rightBounds = modelBounds(after);
  const changedBounds = Object.keys({ ...leftBounds, ...rightBounds }).filter(
    (key) => !same(leftBounds[key], rightBounds[key]),
  );
  if (changedBounds.length)
    reasons.push(
      `The runs used different model bounds: ${changedBounds.join(', ')}.`,
    );
  return reasons;
}

/** Replayable events: the event type plus the payload the checker chose. */
function replay(trace) {
  return {
    traceId: trace.id,
    initial: trace.states[0]?.variables ?? {},
    events: trace.steps.map((step) => {
      const type = step.eventTypes?.[0] ?? step.action;
      // Native step actions read `TYPE {"field":value}` when the event has a payload.
      let payload;
      if (step.action.startsWith(`${type} {`))
        try {
          payload = JSON.parse(step.action.slice(type.length + 1));
        } catch {
          payload = undefined;
        }
      return payload && typeof payload === 'object' ? { type, ...payload } : { type };
    }),
    ...(trace.loopStart !== undefined ? { loopStart: trace.loopStart } : {}),
    ...(trace.stutters !== undefined ? { stutters: trace.stutters } : {}),
  };
}

export async function compareRuns(beforePath, afterPath, { force = false } = {}) {
  const [before, after] = await Promise.all([readRun(beforePath), readRun(afterPath)]);
  const reasons = differences(before, after);
  if (reasons.length && !force)
    throw Object.assign(
      Error(
        `Cannot compare these runs. ${reasons.join(' ')} Rerun both with the same rules and bounds, or pass --force to compare anyway.`,
      ),
      { code: 'ECOMPARE', reasons },
    );
  const outcomes = (run) => new Map(run.report.rules.map((rule) => [rule.id, rule.outcome]));
  const left = outcomes(before);
  const right = outcomes(after);
  const traces = (run, ruleId) =>
    run.report.traces.filter((trace) => trace.ruleId === ruleId).map(replay);
  const comparison = {
    before: before.reportPath,
    after: after.reportPath,
    forced: reasons.length > 0,
    differences: reasons,
    fixed: [],
    stillBroken: [],
    brokenByFix: [],
    notChecked: [],
    stillHolds: [],
    onlyBefore: [],
    onlyAfter: [],
    // Native runs: guards in the after model with no source citation.
    ...(after.report.uncitedConditions
      ? { uncitedConditions: after.report.uncitedConditions }
      : {}),
  };
  for (const [ruleId, outcome] of left) {
    if (!right.has(ruleId)) {
      comparison.onlyBefore.push({ ruleId, outcome });
      continue;
    }
    const next = right.get(ruleId);
    if (outcome === 'not-checked' || next === 'not-checked')
      comparison.notChecked.push({ ruleId, before: outcome, after: next });
    else if (outcome === 'broken' && next === 'holds')
      comparison.fixed.push({ ruleId, counterexamples: traces(before, ruleId) });
    else if (outcome === 'broken')
      comparison.stillBroken.push({ ruleId, counterexamples: traces(after, ruleId) });
    else if (next === 'broken')
      comparison.brokenByFix.push({ ruleId, counterexamples: traces(after, ruleId) });
    else comparison.stillHolds.push({ ruleId });
  }
  for (const [ruleId, outcome] of right)
    if (!left.has(ruleId)) comparison.onlyAfter.push({ ruleId, outcome });
  // Any rule broken in the after run fails, including one not checked before.
  comparison.exit = [...right.values()].some((outcome) => outcome === 'broken')
    ? 1
    : 0;
  return comparison;
}

const eventText = (event) => {
  const { type, ...payload } = event;
  return Object.keys(payload).length ? `${type} ${JSON.stringify(payload)}` : type;
};
export function compareText(comparison) {
  const lines = [`# Check comparison`, '', `Before: ${comparison.before}`, `After: ${comparison.after}`, ''];
  if (comparison.forced)
    lines.push('Compared with --force despite these differences:', ...comparison.differences.map((reason) => `- ${reason}`), '');
  const section = (title, items, describe) => {
    lines.push(`## ${title} (${items.length})`, '');
    if (!items.length) lines.push('None.');
    for (const item of items) lines.push(...describe(item));
    lines.push('');
  };
  const withTraces = (label) => (item) => [
    `- ${item.ruleId}`,
    ...item.counterexamples.map(
      (trace) => `  ${label} ${trace.traceId}: ${trace.events.map(eventText).join(' -> ') || '(initial state)'}`,
    ),
  ];
  section('Fixed', comparison.fixed, withTraces('original counterexample'));
  section('Still broken', comparison.stillBroken, withTraces('counterexample'));
  section('Broken by the fix', comparison.brokenByFix, withTraces('counterexample'));
  section('Not checked', comparison.notChecked, (item) => [`- ${item.ruleId}: ${item.before} before, ${item.after} after`]);
  section('Still holds', comparison.stillHolds, (item) => [`- ${item.ruleId}`]);
  if (comparison.onlyBefore.length || comparison.onlyAfter.length) {
    section('Only in the before run', comparison.onlyBefore, (item) => [`- ${item.ruleId}: ${item.outcome}`]);
    section('Only in the after run', comparison.onlyAfter, (item) => [`- ${item.ruleId}: ${item.outcome}`]);
  }
  if (comparison.uncitedConditions?.length)
    section('Uncited conditions in the after run', comparison.uncitedConditions, (item) => [
      `- ${item.guard ?? '(unnamed guard)'} on ${item.eventType} from ${item.source} (edge ${item.edgeId})`,
    ]);
  if (comparison.fixed.length)
    lines.push(
      'Replay each original counterexample against the fixed model (for example with simulate_machine) to confirm the fix.',
      '',
    );
  return lines.join('\n');
}
