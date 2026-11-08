import { basename, resolve } from 'node:path';
import { parseCheckResult, sha256 } from './check-result.mjs';
import { projectedView, checkReport, attachReport } from './checked-view.mjs';
const prefix = (path, parent) =>
  parent.every((part, index) => path[index] === part);

/** Explicit native slice; verdicts, source bindings and the complete external result remain intact. */
export function selectCheckView(
  input,
  {
    traceIds = [],
    resultPath = 'check-result.json',
    content = JSON.stringify(input),
  } = {},
) {
  const full = parseCheckResult(input);
  if (
    new Set(traceIds).size !== traceIds.length ||
    traceIds.some(
      (id) => !full.counterexamples.some((trace) => trace.id === id),
    )
  )
    throw Error(
      'Select existing unique counterexample IDs from check-result.json.',
    );
  let result = structuredClone(full);
  if (traceIds.length) {
    const selected = new Set(traceIds);
    result.counterexamples = result.counterexamples.filter((trace) =>
      selected.has(trace.id),
    );
    const stateIds = new Set([
      ...result.states
        .filter((state) => state.initial)
        .map((state) => state.id),
      ...result.counterexamples.flatMap((trace) => trace.states),
    ]);
    const stepIds = new Set(
      result.counterexamples.flatMap((trace) => trace.transitions),
    );
    result.states = result.states.filter((state) => stateIds.has(state.id));
    result.transitions = result.transitions.filter((step) =>
      stepIds.has(step.id),
    );
    if (result.projection) {
      result.projection.stepLabels = result.projection.stepLabels?.filter(
        (step) => stepIds.has(step.id),
      );
      result.projection.regions = result.projection.regions.map((region) => {
        const states = region.states
          .map((state) => ({
            ...state,
            members: state.members.filter((id) => stateIds.has(id)),
          }))
          .filter((state) => state.members.length);
        const has = (path) => states.some((state) => prefix(state.path, path));
        return {
          ...region,
          states,
          steps: region.steps?.filter((step) => has(step.from) && has(step.to)),
          arrows: region.arrows?.filter(
            (arrow) => has(JSON.parse(arrow.from)) && has(JSON.parse(arrow.to)),
          ),
        };
      });
    }
    result.checker.bounds = {
      ...result.checker.bounds,
      viewSlice: {
        selectedTraceIds: traceIds,
        omittedTraceIds: full.counterexamples
          .filter((trace) => !selected.has(trace.id))
          .map((trace) => trace.id),
        availableTraces: full.counterexamples.length,
        fullStateCount: full.states.length,
        fullTransitionCount: full.transitions.length,
      },
    };
  }
  result = parseCheckResult(result);
  const graph = projectedView(result, JSON.stringify(result));
  graph.data.meta['@statelyai.checkResultRef'] = {
    path: basename(resultPath),
    sha256: sha256(content),
  };
  if (traceIds.length)
    graph.data.meta['@statelyai.checkSummary'].partial = true;
  const omitted = full.counterexamples.filter(
    (trace) => !result.counterexamples.some((item) => item.id === trace.id),
  );
  const summary = traceIds.length
    ? `Native view shows ${result.counterexamples.length} of ${full.counterexamples.length} counterexamples. Omitted from this view: ${omitted.map((trace) => trace.id).join(', ') || 'none'}. All original rule verdicts remain unchanged; complete evidence is in ${basename(resultPath)}. This renders the recorded run without executing a new check.`
    : 'Native view of the recorded checker result. This renders existing evidence without executing a new check.';
  const report = checkReport(result, graph, { summary });
  if (report.recheck) report.recheck.resultPath = resolve(resultPath);
  report.artifacts.push({
    role: 'result',
    path: basename(resultPath),
    sha256: sha256(content),
  });
  return attachReport(graph, report);
}
