import {
  entityId,
  parseCheckResult,
  resultToXGraph,
  sha256,
} from './check-result.mjs';
import { serializeCheckView } from './check-view.mjs';

const prefix = (path, parent) =>
  parent.length <= path.length &&
  parent.every((part, index) => path[index] === part);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const projectedId = (region, path) =>
  entityId('projected', JSON.stringify([region, path]));

/** Human projection retains raw membership, hierarchy, conditions and failure marks. */
export function projectedView(input, resultContent) {
  const result = parseCheckResult(input);
  if (
    !result.projection?.regions.length ||
    result.projection.regions.some(
      (region) => !Array.isArray(region.steps) || !Array.isArray(region.arrows),
    )
  )
    return resultToXGraph(result, {
      resultRef: { path: 'check-result.json', content: resultContent },
    });
  const id = entityId('checked', JSON.stringify(result.binding));
  const raw = {
    id,
    nodes: [{ id, parentId: null, data: {} }],
    edges: [],
    annotations: [],
    data: {
      meta: {
        '@statelyai.checkBinding': {
          artifacts: result.binding.artifacts.map(({ role, path, sha256 }) => ({
            role,
            path,
            sha256,
          })),
        },
        '@statelyai.checkResultRef': {
          path: 'check-result.json',
          sha256: sha256(resultContent),
        },
        '@statelyai.checkSummary': {
          schemaVersion: result.schemaVersion,
          checker: result.checker.name,
          version: result.checker.version,
          complete: result.checker.complete,
          bounds: result.checker.bounds,
          assumptions: result.checker.assumptions,
          rules: result.rules,
          states: result.states.length,
          transitions: result.transitions.length,
          partial: false,
        },
      },
    },
  };
  const root = raw.nodes[0];
  const nodes = [
    {
      ...root,
      data: {
        ...root.data,
        key: result.projection.title ?? 'Checked behavior',
        type: result.projection.regions.length > 1 ? 'parallel' : 'compound',
        initialId: null,
        description:
          'Projection of checked configurations. Conditions annotate possible behavior; use Checks to replay exact raw failures. Editing requests spec changes and does not rerun checking.',
      },
    },
  ];
  const edges = [];
  for (const region of result.projection.regions) {
    if (!Array.isArray(region.steps) || !Array.isArray(region.arrows))
      throw Error('Projection lacks resolved steps/arrows.');
    const parent =
      result.projection.regions.length > 1
        ? entityId('region', region.id)
        : root.id;
    if (parent !== root.id)
      nodes.push({
        id: parent,
        parentId: root.id,
        data: {
          key: region.name || 'Behavior',
          type: 'compound',
          initialId: null,
        },
      });
    const byPath = new Map();
    for (const state of region.states) {
      for (let length = 1; length <= state.path.length; length++) {
        const path = state.path.slice(0, length);
        const key = JSON.stringify(path);
        if (!byPath.has(key))
          byPath.set(key, {
            id: projectedId(region.name, path),
            parentId:
              length === 1
                ? parent
                : projectedId(region.name, path.slice(0, -1)),
            data: {
              key: path.at(-1),
              initialId: null,
              meta: {
                '@statelyai.checkProjection': {
                  region: region.name,
                  path,
                  members: [],
                  marks: [],
                },
              },
            },
          });
      }
      const node = byPath.get(JSON.stringify(state.path));
      node.data.meta['@statelyai.checkProjection'].members = state.members;
      node.data.meta['@statelyai.checkProjection'].marks = state.marks;
      node.data.description = state.marks
        .map(
          (mark) =>
            `${mark.kind === 'breaks' ? 'Breaks' : 'May break'}: ${mark.ruleId}`,
        )
        .join('\n');
      if (state.marks.some((mark) => mark.kind === 'breaks'))
        node.data.color = 'red';
      else if (state.marks.length) node.data.color = 'orange';
      else if (
        state.group !== undefined &&
        region.colors?.[String(state.group)]
      )
        node.data.color = region.colors[String(state.group)];
      if (state.initial) {
        for (let length = 0; length < state.path.length; length++) {
          const ancestor =
            length === 0
              ? nodes.find((node) => node.id === parent)
              : byPath.get(JSON.stringify(state.path.slice(0, length)));
          const child = projectedId(
            region.name,
            state.path.slice(0, length + 1),
          );
          if (ancestor.data.meta?.['@statelyai.multipleCheckedInitials'])
            continue;
          if (ancestor.data.initialId == null) ancestor.data.initialId = child;
          else if (ancestor.data.initialId !== child) {
            ancestor.data.initialId = null;
            ancestor.data.meta = {
              ...ancestor.data.meta,
              '@statelyai.multipleCheckedInitials': true,
            };
          }
        }
      }
    }
    for (const node of byPath.values()) {
      const descendants = [...byPath.values()].filter(
        (child) => child.parentId === node.id,
      );
      node.data.type = descendants.length ? 'compound' : 'atomic';
      nodes.push(node);
    }
    region.steps.forEach((step, index) => {
      if (
        !Array.isArray(step.from) ||
        !Array.isArray(step.to) ||
        typeof step.label !== 'string'
      )
        throw Error('Invalid resolved projected step.');
      const arrows = region.arrows.filter(
        (arrow) =>
          prefix(JSON.parse(arrow.from), step.from) &&
          same(JSON.parse(arrow.to), step.to) &&
          arrow.when === step.when,
      );
      const from = projectedId(region.name, step.from),
        to = projectedId(region.name, step.to);
      if (
        !nodes.some((node) => node.id === from) ||
        !nodes.some((node) => node.id === to)
      )
        throw Error('Projected step references an unknown state.');
      const id = entityId(
        'projectedStep',
        JSON.stringify([region.id, index, step]),
      );
      const label = [step.label || 'Inspect transition', step.when]
        .filter(Boolean)
        .join(' · ');
      let eventType = `view: ${label}`;
      while (
        edges.some(
          (edge) => edge.sourceId === from && edge.data.eventType === eventType,
        )
      )
        eventType += ` [${index + 1}]`;
      edges.push({
        id,
        sourceId: from,
        targetId: to,
        data: {
          eventType,
          description: [
            step.label,
            step.when,
            'Synthetic view navigation; exact configurations and variables are in Checks.',
          ]
            .filter(Boolean)
            .join('\n'),
          meta: {
            '@statelyai.checkProjectionStep': {
              region: region.name,
              from: step.from,
              to: step.to,
              labels: arrows.map((arrow) => arrow.label),
              conditions: arrows.map((arrow) => arrow.condition),
            },
          },
        },
      });
    });
  }
  const graph = {
    ...raw,
    nodes,
    edges,
    data: {
      ...raw.data,
      meta: { ...raw.data.meta, '@statelyai.checkViewKind': 'projection' },
    },
  };
  graph.data.meta['@statelyai.checkViewSha256'] = sha256(
    serializeCheckView(graph),
  );
  return graph;
}

export function checkReport(
  result,
  graph,
  {
    summary,
    documents = [],
    recheck,
    status,
    checkedAt = result.checker.checkedAt,
  } = {},
) {
  const members = new Map();
  for (const node of graph.nodes) {
    const raw = node.data?.meta?.['@statelyai.checkState'];
    if (raw) members.set(node.id, [raw.id]);
    const projected = node.data?.meta?.['@statelyai.checkProjection'];
    if (projected) members.set(node.id, projected.members);
  }
  const nodeIds = (rawId) =>
    [...members].filter(([, ids]) => ids.includes(rawId)).map(([id]) => id);
  const beneath = (rawId, nodeId) =>
    graph.nodes.some(
      (node) =>
        members.get(node.id)?.includes(rawId) &&
        (() => {
          for (
            let current = node;
            current;
            current = graph.nodes.find((item) => item.id === current.parentId)
          )
            if (current.id === nodeId) return true;
          return false;
        })(),
    );
  const states = new Map(result.states.map((state) => [state.id, state]));
  const steps = new Map(result.transitions.map((step) => [step.id, step]));
  const labels = new Map(
    (result.projection?.stepLabels ?? []).map((step) => [step.id, step.label]),
  );
  const traces = result.counterexamples.map((trace) => ({
    id: trace.id,
    ruleId: trace.ruleId,
    states: trace.states.map((id) => ({
      rawStateId: id,
      nodeIds: nodeIds(id),
      variables: states.get(id).variables,
    })),
    steps: trace.transitions.map((id) => {
      const step = steps.get(id);
      const edgeIds = graph.edges
        .filter(
          (edge) =>
            edge.data?.meta?.['@statelyai.checkTransition']?.id === id ||
            (beneath(step.from, edge.sourceId) &&
              beneath(step.to, edge.targetId) &&
              edge.data?.meta?.[
                '@statelyai.checkProjectionStep'
              ]?.labels.includes(labels.get(id))),
        )
        .map((edge) => edge.id);
      return {
        id,
        action: step.action,
        edgeIds,
        eventTypes: [],
        targetNodeIds: nodeIds(step.to),
      };
    }),
    ...(trace.loopStart !== undefined ? { loopStart: trace.loopStart } : {}),
    ...(trace.stutters !== undefined ? { stutters: trace.stutters } : {}),
  }));
  return {
    schemaVersion: 'stately.check-report.v1',
    runId:
      result.checker.runId ??
      entityId(
        'run',
        JSON.stringify([
          result.binding.artifacts.map(({ role, path, sha256 }) => ({
            role,
            path,
            sha256,
          })),
          result.checker,
          result.rules,
        ]),
      ),
    status:
      status ??
      (result.rules.some((rule) => rule.outcome === 'not-checked') ||
      !result.checker.complete
        ? 'incomplete'
        : 'complete'),
    checker: {
      name: result.checker.name,
      version: result.checker.version,
      complete: result.checker.complete,
      bounds: result.checker.bounds,
      assumptions: result.checker.assumptions,
    },
    rules: result.rules,
    traces,
    artifacts: result.binding.artifacts.map(({ role, path, sha256 }) => ({
      role,
      path,
      sha256,
    })),
    documents,
    summary:
      summary ??
      'Imported checker evidence: inspect rule outcomes, bounds and missing checks. Application behavior requires separate replay evidence.',
    checkedAt,
    ...((recheck ?? result.recheck)
      ? { recheck: recheck ?? result.recheck }
      : {}),
    applicationChecks: [],
  };
}

export function attachReport(graph, report) {
  report.viewSha256 = sha256(serializeCheckView(graph));
  graph.data.meta['@statelyai.checkViewSha256'] = report.viewSha256;
  graph.data.meta['@statelyai.checkReport'] = report;
  const size = Math.max(
    JSON.stringify(graph).length,
    serializeCheckView(graph).length,
  );
  if (size > 195_000)
    throw Error(
      `Saved view and complete report need ${size} characters (limit 195000). Full artifacts are retained; explicitly select fewer traces/documents or open report.md locally. No evidence was silently discarded.`,
    );
  return graph;
}
