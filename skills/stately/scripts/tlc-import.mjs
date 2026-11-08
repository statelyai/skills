import { RESULT_VERSION, entityId, parseCheckResult } from './check-result.mjs';

const isRecord = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function assert(condition, message) {
  if (!condition) throw new Error(`Unsupported TLC artifact: ${message}`);
}
function base({ content, artifacts, provenance, role }) {
  assert(
    artifacts.some((item) => item.role === role && item.content === content),
    'missing exact input artifact',
  );
  assert(
    ['spec', 'config'].every((role) =>
      artifacts.some((item) => item.role === role),
    ),
    'retain both .tla and .cfg sources',
  );
  return {
    schemaVersion: RESULT_VERSION,
    kind: 'explored-configurations',
    binding: { artifacts },
    checker: {
      name: 'TLC',
      version: provenance.version,
      command: provenance.command,
      bounds: provenance.bounds,
      assumptions: provenance.assumptions,
      complete: false,
    },
    states: [],
    transitions: [],
    rules: [],
    counterexamples: [],
  };
}

/** TLC -dumpTrace json (state/action tuple format); no verdict or coverage inference. */
export function importTlcTrace({ content, artifacts, provenance }) {
  const result = base({ content, artifacts, provenance, role: 'trace' });
  const input = JSON.parse(content);
  assert(
    isRecord(input) &&
      isRecord(input.counterexample) &&
      Array.isArray(input.counterexample.state) &&
      Array.isArray(input.counterexample.action),
    'expected counterexample.state/action tuple JSON',
  );
  const tuple = (value) =>
    Array.isArray(value) &&
    value.length === 2 &&
    Number.isSafeInteger(value[0]) &&
    value[0] > 0 &&
    isRecord(value[1]);
  const tuples = input.counterexample.state;
  assert(tuples.length > 0 && tuples.every(tuple), 'state tuples');
  const states = new Map();
  tuples.forEach(([ordinal, variables], index) => {
    const id = String(ordinal);
    assert(!states.has(id), 'duplicate state ordinal');
    states.set(id, { id, variables, initial: index === 0, violations: [] });
  });
  const sequence = [String(tuples[0][0])],
    steps = [];
  for (const [index, action] of input.counterexample.action.entries()) {
    assert(
      Array.isArray(action) &&
        action.length === 3 &&
        tuple(action[0]) &&
        tuple(action[2]) &&
        isRecord(action[1]) &&
        typeof action[1].name === 'string' &&
        action[1].name.length > 0,
      'action tuple',
    );
    const [from, metadata, to] = action;
    const fromId = String(from[0]),
      toId = String(to[0]);
    assert(states.has(fromId) && states.has(toId), 'unknown action state');
    assert(
      JSON.stringify(states.get(fromId).variables) ===
        JSON.stringify(from[1]) &&
        JSON.stringify(states.get(toId).variables) === JSON.stringify(to[1]),
      'inconsistent action variables',
    );
    assert(sequence.at(-1) === fromId, 'non-contiguous trace');
    const id = `trace_step_${index}`;
    result.transitions.push({
      id,
      from: fromId,
      to: toId,
      action: metadata.name,
      location: metadata.location,
    });
    sequence.push(toId);
    steps.push(id);
  }
  assert(new Set(sequence).size === states.size, 'trace omits supplied states');
  const repeated = sequence.slice(0, -1).indexOf(sequence.at(-1));
  const lastAction = input.counterexample.action.at(-1)?.[1];
  const stutters =
    lastAction?.name === 'UnnamedAction' &&
    lastAction.location?.module === '--TLA+ BUILTINS--';
  assert(uniquePrefix(sequence, repeated), 'non-lasso trace order');
  assert(
    isRecord(provenance.rule) &&
      ['invariant', 'property', 'deadlock'].includes(provenance.rule.kind) &&
      typeof provenance.rule.name === 'string',
    'supply the violated rule from the original TLC result',
  );
  const rule = {
    ...provenance.rule,
    id: `${provenance.rule.kind}:${provenance.rule.name}`,
    outcome: 'broken',
  };
  result.rules.push(rule);
  if (rule.kind !== 'property')
    states.get(sequence.at(-1)).violations.push(rule.id);
  result.states = [...states.values()];
  result.counterexamples.push({
    id: 'trace',
    ruleId: rule.id,
    states: sequence,
    transitions: steps,
    ...(repeated >= 0 ? { loopStart: repeated, stutters } : {}),
  });
  result.importNotes = [
    'Single error trace only; other rules and exploration coverage are unknown. Rule identity supplied from the original TLC result.',
    'Values retain the TLC JSON representation; no arbitrary TLA+ reconstruction.',
  ];
  return parseCheckResult(result);
}
function uniquePrefix(sequence, repeated) {
  const prefix = repeated >= 0 ? sequence.slice(0, -1) : sequence;
  return new Set(prefix).size === prefix.length;
}

/** Standard TLC -dump dot[,actionlabels], not an arbitrary Graphviz parser. */
export function importTlcDot({ content, artifacts, provenance }) {
  const result = base({ content, artifacts, provenance, role: 'dot' });
  const states = new Map();
  const quoted = '"(?:[^"\\\\]|\\\\.)*"';
  const decode = (value) => {
    try {
      return JSON.parse(value);
    } catch {
      assert(false, 'unsupported DOT string escape');
    }
  };
  const attributes = (source) => {
    const values = new Map();
    const pattern = new RegExp(
      `([A-Za-z][A-Za-z0-9_]*)\\s*=\\s*(${quoted}|[A-Za-z][A-Za-z0-9_]*)`,
      'g',
    );
    for (const match of source.matchAll(pattern))
      values.set(
        match[1],
        match[2].startsWith('"') ? decode(match[2]) : match[2],
      );
    return values;
  };
  assert(
    /^\s*(?:strict\s+)?digraph\s+DiskGraph\s*\{/m.test(content),
    'expected TLC DiskGraph DOT',
  );
  for (const line of content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)) {
    const edge = line.match(/^(-?\d+)\s*->\s*(-?\d+)\s*\[(.*)\];?$/);
    if (edge) {
      const [, from, to, attrs] = edge;
      const action = attributes(attrs).get('label') || 'unlabeled TLC step';
      const id = entityId(
        'dotStep',
        JSON.stringify([from, to, action, result.transitions.length]),
      );
      result.transitions.push({ id, from, to, action });
      continue;
    }
    const node = line.match(/^(-?\d+)\s*\[(.*)\];?$/);
    if (node) {
      const [, id, attrs] = node;
      const values = attributes(attrs);
      assert(
        values.has('label') && !states.has(id),
        `missing/duplicate DOT label: ${id}`,
      );
      states.set(id, {
        id,
        variables: { tlcLabel: values.get('label') },
        initial: values.get('style')?.split(',').includes('filled') ?? false,
        violations: [],
      });
      continue;
    }
    assert(
      /^(?:(?:strict\s+)?digraph\s+DiskGraph\s*\{|subgraph\s+cluster_graph\s*\{|\}|\{rank\s*=\s*same;[^{}]*\}|(?:node|edge|graph)\s*\[.*\];?|[A-Za-z]+\s*=\s*[^{};]+;?)$/.test(
        line,
      ),
      `DOT syntax: ${line.slice(0, 100)}`,
    );
  }
  result.states = [...states.values()];
  result.importNotes = [
    'DOT does not contain rule verdicts or completeness; no rules are marked holds.',
    'Variables are retained as the original TLC label text, not reparsed TLA+ values. Fingerprints remain strings, including integers beyond JavaScript precision.',
    'Dump may be partial after an error. Original sources and exact DOT are retained.',
  ];
  return parseCheckResult(result);
}
