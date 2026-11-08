import { artifact, entityId, sha256 } from './check-result.mjs';

const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function assert(condition, message) {
  if (!condition)
    throw new Error(`Unsupported native formal model: ${message}`);
}
function keys(value, allowed, location) {
  assert(record(value), location);
  for (const key of Object.keys(value))
    assert(allowed.includes(key), `${location}.${key}`);
}
function checkMeta(value, location) {
  assert(value == null || record(value), `${location} metadata`);
  for (const key of Object.keys(value ?? {})) {
    assert(
      !key.startsWith('@stately') ||
        ['@statelyai.color', '@statelyai.icon', '@statelyai.evidence'].includes(
          key,
        ),
      `${location} semantic metadata: ${key}`,
    );
  }
}
const safeId = (value) =>
  typeof value === 'string' && /^[\x20-\x7e]+$/.test(value);
const quoted = (value) => JSON.stringify(value);

/** Closed, context-free, deterministic flat subset. Unknown semantics fail closed. */
export function exportNativeTla({
  content,
  path = 'model.xgraph.json',
  module = 'StatelyModel',
  bounds,
  invariants = [],
}) {
  assert(typeof content === 'string', 'supply exact model bytes');
  assert(/^Stately[A-Za-z0-9_]*$/.test(module), 'module name');
  assert(
    record(bounds) &&
      Number.isSafeInteger(bounds.maxStates) &&
      bounds.maxStates > 0 &&
      bounds.maxStates <= 500 &&
      Number.isSafeInteger(bounds.maxTransitions) &&
      bounds.maxTransitions > 0 &&
      bounds.maxTransitions <= 5000,
    'explicit finite maxStates (1..500) and maxTransitions (1..5000)',
  );
  const graph = JSON.parse(content);
  keys(
    graph,
    [
      'id',
      'xgraphSchemaVersion',
      'nodes',
      'edges',
      'annotations',
      'data',
      'initialNodeId',
      'layout',
      'direction',
      'style',
      'parentId',
      'type',
      'mode',
    ],
    'graph',
  );
  assert(
    graph.mode === undefined || graph.mode === 'directed',
    'directed graph required',
  );
  assert(
    graph.type === undefined || ['statechart', 'directed'].includes(graph.type),
    'statechart required',
  );
  assert(
    graph.xgraphSchemaVersion === undefined ||
      graph.xgraphSchemaVersion === '1.0.0',
    'XGraph version',
  );
  assert(
    Array.isArray(graph.nodes) && Array.isArray(graph.edges),
    'nodes/edges',
  );
  if (graph.data !== undefined) {
    checkMeta(graph.data.meta, 'graph');
    keys(
      graph.data,
      [
        'description',
        'name',
        'profile',
        'implementations',
        'schemas',
        'layout',
        'importMetadata',
        'meta',
      ],
      'graph.data',
    );
    if (graph.data.profile !== undefined)
      assert(
        [
          '@statelyai/xstate@5.30.0',
          '@statelyai/xstate@6.0.0-alpha.51',
          'xstate-v5',
          'xstate-v6-alpha',
        ].includes(graph.data.profile),
        'unknown execution profile',
      );
    assert(
      graph.data.schemas === undefined || graph.data.schemas === null,
      'schemas/context payloads',
    );
    assert(
      !record(graph.data.meta) ||
        !Object.hasOwn(graph.data.meta, '@statelyai.checkResult'),
      'configuration graph is not an authored model',
    );
    if (graph.data.implementations !== undefined) {
      keys(
        graph.data.implementations,
        ['actions', 'guards', 'actors', 'delays', 'tags'],
        'implementations',
      );
      assert(
        Object.values(graph.data.implementations).every(
          (items) => Array.isArray(items) && items.length === 0,
        ),
        'implementations must be empty',
      );
    }
  }
  const roots = graph.nodes.filter((node) => node.parentId === null);
  assert(roots.length === 1, 'exactly one root');
  const root = roots[0];
  const leaves = graph.nodes.filter((node) => node !== root);
  assert(
    leaves.length > 0 &&
      leaves.length <= bounds.maxStates &&
      graph.edges.length <= bounds.maxTransitions,
    'finite bounds exceeded',
  );
  assert(
    new Set(graph.nodes.map((node) => node.id)).size === graph.nodes.length,
    'duplicate node IDs',
  );
  assert(
    new Set(graph.edges.map((edge) => edge.id)).size === graph.edges.length,
    'duplicate edge IDs',
  );
  const states = new Map(leaves.map((node) => [node.id, node]));
  for (const node of graph.nodes) {
    keys(
      node,
      [
        'id',
        'type',
        'initialNodeId',
        'parentId',
        'data',
        'label',
        'x',
        'y',
        'width',
        'height',
        'position',
        'dx',
        'dy',
      ],
      `node ${node.id}`,
    );
    assert(safeId(node.id), 'ASCII stable node ID');
    assert(
      node.type === undefined || node.type === 'node',
      'node representation',
    );
    assert(
      node.initialNodeId === undefined ||
        node.initialNodeId === null ||
        (node === root && node.initialNodeId === node.data?.initialId),
      'node initialNodeId',
    );
    keys(
      node.data,
      [
        'key',
        'nodeId',
        'type',
        'history',
        'initialId',
        'entry',
        'exit',
        'invokes',
        'description',
        'color',
        'meta',
        'tags',
      ],
      `node ${node.id}.data`,
    );
    assert(
      node.data.nodeId === undefined || node.data.nodeId === node.id,
      'nodeId must match graph entity ID',
    );
    assert(
      node.data.history === undefined || node.data.history === false,
      'history',
    );
    checkMeta(node.data.meta, `node ${node.id}`);
    assert(
      typeof node.data.key === 'string' && node.data.key.length > 0,
      'state key',
    );
    assert(
      !record(node.data.meta) ||
        !Object.hasOwn(node.data.meta, '@statelyai.checkState'),
      'configuration graph is not an authored model',
    );
    for (const field of ['entry', 'exit', 'invokes'])
      assert(
        node.data[field] === undefined ||
          (Array.isArray(node.data[field]) && node.data[field].length === 0),
        `${node.id}: ${field}`,
      );
    if (node === root)
      assert(
        node.data.type == null || node.data.type === 'compound',
        'root hierarchy/parallel/history',
      );
    else {
      assert(node.parentId === root.id, 'nested hierarchy or parallel region');
      assert(
        node.data.type == null || ['atomic', 'final'].includes(node.data.type),
        'history/parallel/compound state',
      );
      assert(node.data.initialId === undefined, 'leaf initial state');
    }
  }
  assert(
    new Set(leaves.map((node) => node.data.key)).size === leaves.length,
    'duplicate state keys',
  );
  assert(
    states.has(root.data.initialId),
    'root initialId must name a direct child',
  );
  assert(
    graph.initialNodeId === undefined ||
      graph.initialNodeId === null ||
      [root.id, root.data.initialId].includes(graph.initialNodeId),
    'conflicting initialNodeId',
  );
  const seen = new Set();
  for (const edge of graph.edges) {
    keys(
      edge,
      [
        'id',
        'type',
        'sourceId',
        'targetId',
        'data',
        'label',
        'x',
        'y',
        'width',
        'height',
        'position',
        'dx',
        'dy',
        'mode',
      ],
      `edge ${edge.id}`,
    );
    assert(
      edge.type === undefined || edge.type === 'edge',
      'edge representation',
    );
    assert(
      edge.mode === undefined || edge.mode === 'directed',
      'directed transition',
    );
    assert(
      safeId(edge.id) && states.has(edge.sourceId) && states.has(edge.targetId),
      'transition references direct children',
    );
    keys(
      edge.data,
      [
        'eventType',
        'transitionType',
        'guard',
        'actions',
        'description',
        'color',
        'meta',
      ],
      `edge ${edge.id}.data`,
    );
    assert(
      edge.data.transitionType === undefined ||
        edge.data.transitionType === 'normal',
      'transition semantics',
    );
    assert(edge.data.guard === undefined || edge.data.guard === null, 'guard');
    checkMeta(edge.data.meta, `edge ${edge.id}`);
    const event = edge.data.eventType;
    assert(
      typeof event === 'string' &&
        event.trim().length > 0 &&
        !/[\x00-\x1f*]/.test(event) &&
        !event.startsWith('xstate.') &&
        !event.startsWith('done.') &&
        !event.startsWith('error.') &&
        !event.startsWith('@statelyai.') &&
        !event.startsWith('@stately.'),
      'plain external event; no wildcards/timers/actor completion',
    );
    assert(
      edge.data.actions === undefined ||
        (Array.isArray(edge.data.actions) && edge.data.actions.length === 0),
      'actions',
    );
    assert(
      states.get(edge.sourceId).data.type !== 'final',
      'outgoing transition from final state',
    );
    const key = JSON.stringify([edge.sourceId, event]);
    assert(!seen.has(key), 'ordered/guarded or nondeterministic branches');
    seen.add(key);
  }
  assert(Array.isArray(invariants), 'invariants');
  const invariantNames = new Set([
    'Init',
    'Next',
    'Spec',
    'TypeOK',
    'States',
    'pc',
  ]);
  for (const rule of invariants) {
    keys(rule, ['name', 'forbiddenStateIds'], 'invariant');
    assert(
      typeof rule.name === 'string' &&
        rule.name.length > 0 &&
        !invariantNames.has(rule.name),
      'unique invariant name',
    );
    invariantNames.add(rule.name);
    assert(
      Array.isArray(rule.forbiddenStateIds) &&
        rule.forbiddenStateIds.length > 0 &&
        rule.forbiddenStateIds.every((id) => states.has(id)),
      'invariant state membership',
    );
  }
  const mappedInvariants = invariants.map((rule) => ({
    ...rule,
    tlaName: entityId('Invariant', rule.name),
  }));
  const actions = graph.edges.map((edge) => ({
    edgeId: edge.id,
    action: entityId('Transition', edge.id),
    eventType: edge.data.eventType,
    from: edge.sourceId,
    to: edge.targetId,
  }));
  assert(
    actions.every((item) => !invariantNames.has(item.action)),
    'action/invariant name collision',
  );
  const spec = [
    `---- MODULE ${module} ----`,
    'EXTENDS TLC',
    'VARIABLE pc',
    `States == {${leaves.map((node) => quoted(node.id)).join(', ')}}`,
    `Init == pc = ${quoted(root.data.initialId)}`,
    ...actions.map(
      (item) =>
        `${item.action} == /\\ pc = ${quoted(item.from)}\n    /\\ pc' = ${quoted(item.to)}`,
    ),
    `Next == ${actions.map((item) => item.action).join(' \\/ ') || 'FALSE'}`,
    'Spec == Init /\\ [][Next]_pc',
    'TypeOK == pc \\in States',
    ...mappedInvariants.map(
      (rule) =>
        `${rule.tlaName} == pc \\notin {${rule.forbiddenStateIds.map(quoted).join(', ')}}`,
    ),
    '====',
    '',
  ].join('\n');
  const config = [
    'SPECIFICATION Spec',
    'INVARIANT TypeOK',
    ...mappedInvariants.map((rule) => `INVARIANT ${rule.tlaName}`),
    'CHECK_DEADLOCK FALSE',
    '',
  ].join('\n');
  const assumptions = [
    'One external event is processed per atomic transition. Event choice is nondeterministic; unhandled events stutter.',
    'No context, payloads, JavaScript guards/actions, timers, actors, hierarchy, parallelism, history, internal events, or fairness. No liveness claim.',
    'The complete finite control graph is checked, not application code. CHECK_DEADLOCK FALSE: terminal states and ignored events are permitted.',
  ];
  return {
    spec,
    config,
    manifest: {
      schemaVersion: 'stately.native-tla.v1',
      subset: 'flat-external-events-v1',
      binding: {
        artifacts: [
          artifact('model', path, content),
          artifact('spec', `${module}.tla`, spec),
          artifact('config', `${module}.cfg`, config),
        ],
      },
      bounds,
      assumptions,
      states: leaves.map((node) => ({
        nodeId: node.id,
        key: node.data.key,
        tlaValue: node.id,
      })),
      actions,
      initialStateId: root.data.initialId,
      modelSha256: sha256(content),
      invariants: mappedInvariants,
    },
  };
}
