import { RESULT_VERSION, entityId, parseCheckResult } from './check-result.mjs';

/** Convert a completed owned engine run without executing projection callbacks twice. */
export function exportEngineResult({
  result,
  walked,
  chart,
  labels,
  found,
  artifacts,
  checker,
}) {
  const ruleId = (rule) => `${rule.kind}:${rule.name}`;
  const verdicts = [...result.rules, ...result.properties];
  const rules = verdicts.map(({ rule, outcome }) => ({
    id: ruleId(rule),
    ...rule,
    outcome: outcome === 'not checked' ? 'not-checked' : outcome,
  }));
  const transitionId = (step) =>
    entityId('rawStep', JSON.stringify([step.from, step.to, step.action]));
  const transitions = new Map();
  for (const step of result.graph.steps)
    transitions.set(transitionId(step), { id: transitionId(step), ...step });
  const states = new Map(
    [...result.graph.states].map(([id, state]) => [
      id,
      {
        id,
        variables: state.vars,
        initial: state.start,
        violations: state.breaks.map(ruleId),
        boundary: {
          past: state.past === true,
          excluded: state.excluded === true,
        },
      },
    ]),
  );
  const counterexamples = found.map((bug, index) => {
    const sequence = [bug.start, ...bug.path.map((step) => step.state)];
    const steps = bug.path.map(({ step }) => {
      transitions.set(transitionId(step), { id: transitionId(step), ...step });
      return transitionId(step);
    });
    return {
      id: `counterexample_${index}`,
      ruleId: ruleId(bug.rule),
      states: sequence,
      transitions: steps,
      ...(bug.loop !== undefined ? { loopStart: bug.loop } : {}),
      ...(bug.stutters !== undefined ? { stutters: bug.stutters } : {}),
    };
  });
  const projection = chart && {
    title: chart.title,
    stepLabels: labels
      ? result.graph.steps.map((step, index) => ({
          id: transitionId(step),
          label: labels.drawnLabels[index],
        }))
      : [],
    regions: chart.regions.map((region, index) => ({
      id: `region_${index}`,
      name: region.name,
      states: region.states.map((state) => ({
        id: entityId('projected', JSON.stringify([region.name, state.path])),
        path: state.path,
        members: state.members.map((member) => walked.ids[member]),
        initial: state.start,
        ...(state.group !== undefined ? { group: state.group } : {}),
        marks: state.breaks.map(({ rule, always }) => ({
          ruleId: ruleId(rule),
          kind: always ? 'breaks' : 'mayBreak',
        })),
      })),
      steps: region.steps,
      colors: chart.colors,
      // Keep resolved conditions, including Set values, without executing the view again.
      arrows: JSON.parse(
        JSON.stringify(region.arrows, (_, value) =>
          value instanceof Set ? [...value] : value,
        ),
      ),
    })),
    notes: chart.notes,
    hiddenSteps: chart.quiet,
    paths: chart.paths,
    loops: chart.loops,
    ...(chart.lie ? { warning: chart.lie } : {}),
  };
  return parseCheckResult({
    schemaVersion: RESULT_VERSION,
    kind: result.graph.states.size ? 'explored-configurations' : 'summary-only',
    binding: { artifacts },
    checker: {
      ...checker,
      complete: result.states.complete,
      exit: result.exit,
      stateCounts: result.states,
      stop: result.stop,
    },
    states: [...states.values()],
    transitions: [...transitions.values()],
    rules,
    counterexamples,
    ...(projection ? { projection } : {}),
  });
}
