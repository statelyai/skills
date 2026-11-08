import { createHash } from 'node:crypto';
import { canonicalCheckView as canonicalGraphView } from './check-view.mjs';

export const RESULT_VERSION = 'stately.check-result.v1';
export const sha256 = (bytes) =>
  createHash('sha256').update(bytes).digest('hex');
export const artifact = (role, path, content) => ({
  role,
  path,
  content,
  sha256: sha256(content),
});
export const entityId = (kind, value) =>
  `${kind}_${sha256(value).slice(0, 24)}`;

function requireValue(condition, message) {
  if (!condition) throw new Error(`Invalid check result: ${message}`);
}
const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const string = (value) => typeof value === 'string' && value.length > 0;
const strings = (value) => Array.isArray(value) && value.every(string);
const unique = (values) => new Set(values).size === values.length;

/** Parse the producer boundary once, including references and exact-byte bindings. */
export function parseCheckResult(input) {
  requireValue(
    record(input) && input.schemaVersion === RESULT_VERSION,
    'schemaVersion',
  );
  requireValue(
    ['explored-configurations', 'summary-only'].includes(input.kind),
    'kind',
  );
  requireValue(
    record(input.checker) &&
      string(input.checker.name) &&
      string(input.checker.version),
    'checker identity',
  );
  requireValue(
    strings(input.checker.command) && input.checker.command.length > 0,
    'checker command',
  );
  requireValue(
    typeof input.checker.complete === 'boolean',
    'exploration completeness',
  );
  requireValue(
    record(input.checker.bounds) &&
      Array.isArray(input.checker.assumptions) &&
      input.checker.assumptions.every(string),
    'bounds and assumptions',
  );
  requireValue(
    record(input.binding) &&
      Array.isArray(input.binding.artifacts) &&
      input.binding.artifacts.length > 0,
    'artifacts',
  );
  for (const item of input.binding.artifacts) {
    requireValue(
      record(item) &&
        ['spec', 'config', 'model', 'view', 'trace', 'dot', 'scope'].includes(
          item.role,
        ) &&
        string(item.path),
      'artifact identity',
    );
    requireValue(
      typeof item.content === 'string' && item.sha256 === sha256(item.content),
      `artifact digest: ${item.path}`,
    );
  }
  requireValue(
    unique(input.binding.artifacts.map((item) => item.path)),
    'duplicate artifact paths',
  );
  for (const key of ['states', 'transitions', 'rules', 'counterexamples']) {
    requireValue(Array.isArray(input[key]), key);
    requireValue(
      input[key].every((item) => record(item) && string(item.id)),
      `${key} IDs`,
    );
    requireValue(
      unique(input[key].map((item) => item.id)),
      `duplicate ${key} IDs`,
    );
  }
  requireValue(
    (input.kind === 'explored-configurations' && input.states.length > 0) ||
      (input.kind === 'summary-only' &&
        input.states.length === 0 &&
        input.transitions.length === 0 &&
        input.counterexamples.length === 0),
    'empty state graph',
  );
  const rules = new Map(input.rules.map((rule) => [rule.id, rule]));
  const states = new Map(input.states.map((state) => [state.id, state]));
  const transitions = new Map(input.transitions.map((step) => [step.id, step]));
  for (const rule of rules.values()) {
    requireValue(
      string(rule.name) &&
        ['invariant', 'property', 'deadlock'].includes(rule.kind),
      'rule',
    );
    requireValue(
      ['holds', 'broken', 'not-checked'].includes(rule.outcome),
      `rule outcome: ${rule.id}`,
    );
  }
  for (const state of states.values()) {
    requireValue(
      record(state.variables) &&
        typeof state.initial === 'boolean' &&
        strings(state.violations),
      `state: ${state.id}`,
    );
    requireValue(
      state.violations.every((id) => rules.get(id)?.outcome === 'broken'),
      `violations: ${state.id}`,
    );
  }
  requireValue(
    input.states.some((state) => state.initial) ||
      input.kind === 'summary-only',
    'missing initial state',
  );
  for (const step of transitions.values()) {
    requireValue(
      states.has(step.from) && states.has(step.to) && string(step.action),
      `transition: ${step.id}`,
    );
  }
  for (const path of input.counterexamples) {
    requireValue(
      rules.get(path.ruleId)?.outcome === 'broken',
      `counterexample rule: ${path.id}`,
    );
    requireValue(
      strings(path.states) &&
        path.states.length > 0 &&
        path.states.every((id) => states.has(id)),
      `counterexample states: ${path.id}`,
    );
    requireValue(
      strings(path.transitions) &&
        path.transitions.length === path.states.length - 1,
      `counterexample length: ${path.id}`,
    );
    requireValue(
      states.get(path.states[0]).initial,
      `counterexample initial state: ${path.id}`,
    );
    path.transitions.forEach((id, index) =>
      requireValue(
        transitions.get(id)?.from === path.states[index] &&
          transitions.get(id)?.to === path.states[index + 1],
        `counterexample transition: ${path.id}/${index}`,
      ),
    );
    if (path.loopStart !== undefined)
      requireValue(
        Number.isInteger(path.loopStart) &&
          path.loopStart >= 0 &&
          path.loopStart < path.states.length,
        `loop index: ${path.id}`,
      );
    if (path.loopStart !== undefined)
      requireValue(
        path.states.at(-1) === path.states[path.loopStart] ||
          (path.stutters === true && path.loopStart === path.states.length - 1),
        `loop closure: ${path.id}`,
      );
    if (path.stutters !== undefined)
      requireValue(
        typeof path.stutters === 'boolean',
        `stuttering: ${path.id}`,
      );
  }
  if (input.projection !== undefined) {
    requireValue(
      record(input.projection) &&
        Array.isArray(input.projection.regions) &&
        Array.isArray(input.projection.notes),
      'projection',
    );
    for (const region of input.projection.regions) {
      requireValue(
        record(region) &&
          string(region.id) &&
          typeof region.name === 'string' &&
          Array.isArray(region.states),
        'projected region',
      );
      requireValue(
        unique(region.states.map((state) => state.id)),
        'duplicate projected IDs',
      );
      for (const state of region.states) {
        requireValue(
          record(state) &&
            string(state.id) &&
            strings(state.path) &&
            state.path.length > 0,
          'projected state',
        );
        requireValue(
          strings(state.members) &&
            state.members.length > 0 &&
            state.members.every((id) => states.has(id)),
          'raw-state mapping',
        );
        requireValue(
          Array.isArray(state.marks) &&
            state.marks.every(
              (mark) =>
                rules.get(mark.ruleId)?.outcome === 'broken' &&
                ['breaks', 'mayBreak'].includes(mark.kind),
            ),
          'projection rule marks',
        );
      }
    }
  }
  return input;
}

/** Compare exact current bytes; absent files remain unknown, never fresh. */
export function resultFreshness(input, currentArtifacts = {}) {
  const result = parseCheckResult(input);
  const unknown = [],
    changed = [];
  for (const item of result.binding.artifacts) {
    if (!Object.hasOwn(currentArtifacts, item.path)) unknown.push(item.path);
    else if (sha256(currentArtifacts[item.path]) !== item.sha256)
      changed.push(item.path);
  }
  return {
    status: changed.length
      ? 'outdated'
      : unknown.length
        ? 'unknown'
        : 'current',
    changed,
    unknown,
  };
}

export const editorViewCharacters = 180_000;

/** A navigable configuration graph, never an editable reconstruction of a TLA+ spec. */
export function resultToXGraph(input, { resultRef } = {}) {
  const result = parseCheckResult(input);
  const id = entityId('checked', JSON.stringify(result.binding));
  const nodeId = (rawId) => entityId('configuration', rawId);
  const starts = result.states.filter((state) => state.initial);
  const root = {
    id,
    parentId: null,
    data: {
      key:
        result.kind === 'summary-only'
          ? 'Check results'
          : 'Checked configurations',
      initialId:
        starts.length === 0
          ? null
          : starts.length === 1
            ? nodeId(starts[0].id)
            : `${id}_initial`,
      description:
        'Explored checker configurations. Navigation events are synthetic; editing does not change the spec or rerun the checker.',
    },
  };
  const nodes = [
    root,
    ...result.states.map((state) => ({
      id: nodeId(state.id),
      parentId: id,
      data: {
        key: state.id,
        description: JSON.stringify(state.variables, null, 2),
        ...(state.violations.length ? { color: 'red' } : {}),
        meta: { '@statelyai.checkState': state },
      },
    })),
  ];
  const edges = result.transitions.map((step) => ({
    id: entityId('step', step.id),
    sourceId: nodeId(step.from),
    targetId: nodeId(step.to),
    data: {
      eventType: entityId('navigate', step.id),
      description: step.label ?? step.action,
      meta: { '@statelyai.checkTransition': step },
    },
  }));
  if (starts.length > 1) {
    nodes.push({
      id: `${id}_initial`,
      parentId: id,
      data: { key: 'Choose initial configuration' },
    });
    starts.forEach((state) =>
      edges.push({
        id: entityId('initial', state.id),
        sourceId: `${id}_initial`,
        targetId: nodeId(state.id),
        data: {
          eventType: entityId('start', state.id),
          description: 'Synthetic selection of a checker initial configuration',
        },
      }),
    );
  }
  let external;
  if (resultRef !== undefined) {
    requireValue(
      record(resultRef) &&
        string(resultRef.path) &&
        typeof resultRef.content === 'string',
      'external result reference',
    );
    requireValue(
      JSON.stringify(parseCheckResult(JSON.parse(resultRef.content))) ===
        JSON.stringify(result),
      'external result differs from input',
    );
    external = { path: resultRef.path, sha256: sha256(resultRef.content) };
  }
  const checkBinding = {
    artifacts: result.binding.artifacts.map(({ role, path, sha256 }) => ({
      role,
      path,
      sha256,
    })),
  };
  const summary = {
    schemaVersion: RESULT_VERSION,
    checker: result.checker.name,
    version: result.checker.version,
    complete: result.checker.complete,
    bounds: result.checker.bounds,
    assumptions: result.checker.assumptions,
    rules: result.rules,
    states: result.states.length,
    transitions: result.transitions.length,
    partial: false,
  };
  const graph = {
    id,
    nodes,
    edges,
    annotations: [],
    data: {
      meta: {
        '@statelyai.checkBinding': checkBinding,
        '@statelyai.checkSummary': summary,
        ...(external ? { '@statelyai.checkResultRef': external } : {}),
      },
    },
  };
  const bind = (view) => {
    view.data.meta['@statelyai.checkViewSha256'] = graphViewSha256(view);
    return view;
  };
  if (viewCharacters(bind(graph)) <= editorViewCharacters) return graph;
  requireValue(
    external,
    'view exceeds the editor size budget; retain full result JSON and supply resultRef { path, content } for a partial navigation view',
  );
  const requiredNodes = new Set([
    id,
    `${id}_initial`,
    ...starts.map((state) => nodeId(state.id)),
  ]);
  const requiredEdges = new Set();
  for (const path of result.counterexamples) {
    path.states.forEach((rawId) => requiredNodes.add(nodeId(rawId)));
    path.transitions.forEach((stepId) =>
      requiredEdges.add(entityId('step', stepId)),
    );
  }
  const view = {
    ...graph,
    nodes: nodes.filter((node) => requiredNodes.has(node.id)),
    edges: edges.filter(
      (edge) => requiredEdges.has(edge.id) || edge.sourceId === `${id}_initial`,
    ),
    data: {
      meta: {
        '@statelyai.checkResultRef': external,
        '@statelyai.checkBinding': checkBinding,
        '@statelyai.checkSummary': { ...summary, partial: true },
      },
    },
  };
  view.nodes[0] = {
    ...root,
    data: {
      ...root.data,
      description: `${root.data.description} Partial navigation view. Full evidence: ${external.path}. All counterexample paths are retained; other configurations may be omitted.`,
    },
  };
  requireValue(
    viewCharacters(bind(view)) <= editorViewCharacters,
    'counterexample view exceeds the editor size budget; retain full result JSON and narrow the checked model or display fewer counterexamples explicitly',
  );
  const selected = new Set(view.nodes.map((node) => node.id));
  const keptEdges = new Set(view.edges.map((edge) => edge.id));
  const outgoing = new Map();
  for (const edge of edges)
    outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge]);
  const queue = [...selected];
  const byId = new Map(nodes.map((node) => [node.id, node]));
  let full = false;
  for (let cursor = 0; cursor < queue.length && !full; cursor++) {
    for (const edge of outgoing.get(queue[cursor]) ?? []) {
      if (keptEdges.has(edge.id)) continue;
      const added = !selected.has(edge.targetId);
      if (added) view.nodes.push(byId.get(edge.targetId));
      view.edges.push(edge);
      if (viewCharacters(bind(view)) > editorViewCharacters) {
        view.edges.pop();
        if (added) view.nodes.pop();
        full = true;
        break;
      }
      keptEdges.add(edge.id);
      if (added) {
        selected.add(edge.targetId);
        queue.push(edge.targetId);
      }
    }
  }
  return bind(view);
}

function graphViewSha256(graph) {
  return sha256(JSON.stringify(canonicalGraphView(graph)));
}
function viewCharacters(graph) {
  return Math.max(
    JSON.stringify(graph).length,
    JSON.stringify(canonicalGraphView(graph)).length,
  );
}

/** Recheck a retrieved view before presenting attached evidence as current. */
export function graphCheckFreshness(graph, currentArtifacts = {}) {
  const meta = graph.data?.meta;
  if (!record(meta) || typeof meta['@statelyai.checkViewSha256'] !== 'string')
    return { status: 'unknown', changed: [], unknown: ['view binding'] };
  if (meta['@statelyai.checkViewSha256'] !== graphViewSha256(graph))
    return { status: 'outdated', changed: ['configuration view'], unknown: [] };
  if (record(meta['@statelyai.checkResultRef'])) {
    const ref = meta['@statelyai.checkResultRef'];
    if (
      !string(ref.path) ||
      typeof ref.sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(ref.sha256)
    )
      return { status: 'unknown', changed: [], unknown: ['result reference'] };
    if (!Object.hasOwn(currentArtifacts, ref.path))
      return { status: 'unknown', changed: [], unknown: [ref.path] };
    const content = currentArtifacts[ref.path];
    if (sha256(content) !== ref.sha256)
      return { status: 'outdated', changed: [ref.path], unknown: [] };
    return resultFreshness(JSON.parse(content), currentArtifacts);
  }
  const artifacts = meta['@statelyai.checkBinding']?.artifacts;
  if (
    !Array.isArray(artifacts) ||
    !artifacts.length ||
    !artifacts.every(
      (item) =>
        record(item) &&
        string(item.path) &&
        typeof item.sha256 === 'string' &&
        /^[a-f0-9]{64}$/.test(item.sha256),
    )
  )
    return { status: 'unknown', changed: [], unknown: ['result binding'] };
  const changed = [],
    unknown = [];
  for (const item of artifacts) {
    if (!Object.hasOwn(currentArtifacts, item.path)) unknown.push(item.path);
    else if (sha256(currentArtifacts[item.path]) !== item.sha256)
      changed.push(item.path);
  }
  return {
    status: changed.length
      ? 'outdated'
      : unknown.length
        ? 'unknown'
        : 'current',
    changed,
    unknown,
  };
}
