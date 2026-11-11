#!/usr/bin/env node
// Spike: a bounded explicit-state checker over the native statechart graph.
// Plain Node, no Java, no downloads. See .scratch/js-checker-spike.md.
//
// Input: a model (native XGraph or an XState machine config) plus a rules file.
// Output: check-result.json (stately.check-result.v1) and graph.json (the native
// model with a stately.check-report.v1 attached), so counterexample paths point
// at native node and edge IDs directly.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';
import { artifact, parseCheckResult, sha256 } from './check-result.mjs';
import { attachReport } from './checked-view.mjs';

export const CHECKER_NAME = 'stately-native-check';
export const CHECKER_VERSION = '0.1.0-spike';

const record = (value) =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) {
  throw new Error(`native-check: ${message}`);
}

// ---------------------------------------------------------------------------
// Expression language: guards, actions and rule predicates share one grammar.
//   literals: numbers, 'strings', true, false
//   identifiers: context variables; event.x reads an event payload field
//   operators: || && ! == != < <= > >= + - * / %   (precedence as in JS)
//   calls: in('State.path'), min(a,b), max(a,b), abs(a)
// Everything else is rejected at parse time, so a rules file cannot run code.
// ---------------------------------------------------------------------------

const TOKEN =
  /\s*(?:(\d+(?:\.\d+)?)|('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")|([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*)|(==|!=|<=|>=|&&|\|\||[-+*/%<>!(),?:]))/y;

export function parseExpression(source) {
  if (typeof source !== 'string' || !source.trim())
    fail(`empty expression`);
  const tokens = [];
  TOKEN.lastIndex = 0;
  let position = 0;
  while (position < source.length) {
    TOKEN.lastIndex = position;
    const match = TOKEN.exec(source);
    if (!match) {
      if (!source.slice(position).trim()) break;
      fail(`cannot read expression near "${source.slice(position, position + 12)}" in: ${source}`);
    }
    position = TOKEN.lastIndex;
    if (match[1] !== undefined) tokens.push({ kind: 'number', value: Number(match[1]) });
    else if (match[2] !== undefined)
      tokens.push({ kind: 'string', value: match[2].slice(1, -1).replace(/\\(.)/g, '$1') });
    else if (match[3] !== undefined) {
      const word = match[3];
      if (word === 'true' || word === 'false') tokens.push({ kind: 'bool', value: word === 'true' });
      else tokens.push({ kind: 'name', value: word });
    } else tokens.push({ kind: 'op', value: match[4] });
  }
  let index = 0;
  const peek = () => tokens[index];
  const take = (value) => {
    const token = tokens[index];
    if (!token || (value !== undefined && token.value !== value))
      fail(`expected ${value ?? 'a value'} in: ${source}`);
    index++;
    return token;
  };
  const binary = (levels, level = 0) => {
    if (level === levels.length) return unary();
    let left = binary(levels, level + 1);
    while (peek()?.kind === 'op' && levels[level].includes(peek().value)) {
      const op = take().value;
      const right = binary(levels, level + 1);
      left = { op, left, right };
    }
    return left;
  };
  const unary = () => {
    if (peek()?.kind === 'op' && peek().value === '!') {
      take();
      return { op: '!', arg: unary() };
    }
    if (peek()?.kind === 'op' && peek().value === '-') {
      take();
      return { op: 'neg', arg: unary() };
    }
    return primary();
  };
  const primary = () => {
    const token = take();
    if (token.kind === 'op' && token.value === '(') {
      const inner = expression();
      take(')');
      return inner;
    }
    if (token.kind === 'number' || token.kind === 'string' || token.kind === 'bool')
      return { lit: token.value };
    if (token.kind === 'name') {
      if (peek()?.kind === 'op' && peek().value === '(') {
        take('(');
        const args = [];
        if (!(peek()?.kind === 'op' && peek().value === ')'))
          do args.push(expression());
          while (peek()?.kind === 'op' && peek().value === ',' && take());
        take(')');
        if (!['in', 'min', 'max', 'abs'].includes(token.value))
          fail(`unknown function ${token.value} in: ${source}`);
        return { call: token.value, args };
      }
      return { ref: token.value };
    }
    fail(`unexpected ${token.value} in: ${source}`);
  };
  const expression = () => {
    const test = binary([['||'], ['&&'], ['==', '!='], ['<', '<=', '>', '>='], ['+', '-'], ['*', '/', '%']]);
    if (peek()?.kind === 'op' && peek().value === '?') {
      take('?');
      const then = expression();
      take(':');
      return { cond: test, then, otherwise: expression() };
    }
    return test;
  };
  const ast = expression();
  if (index !== tokens.length) fail(`trailing input in: ${source}`);
  return ast;
}

/** Free variable references of an expression (dotted names kept whole). */
export function expressionRefs(ast, out = new Set()) {
  if (!ast) return out;
  if (ast.ref) out.add(ast.ref);
  if (ast.left) expressionRefs(ast.left, out);
  if (ast.right) expressionRefs(ast.right, out);
  if (ast.arg) expressionRefs(ast.arg, out);
  if (ast.cond) expressionRefs(ast.cond, out), expressionRefs(ast.then, out), expressionRefs(ast.otherwise, out);
  if (ast.args) ast.args.forEach((arg) => expressionRefs(arg, out));
  return out;
}

export function evaluate(ast, scope) {
  if ('lit' in ast) return ast.lit;
  if (ast.cond) return evaluate(ast.cond, scope) ? evaluate(ast.then, scope) : evaluate(ast.otherwise, scope);
  if (ast.ref) {
    const [head, ...rest] = ast.ref.split('.');
    let value;
    if (head === 'event' && scope.event && !Object.hasOwn(scope.vars, 'event')) value = scope.event;
    else if (Object.hasOwn(scope.vars, head)) value = scope.vars[head];
    else throw new Unresolved(`unknown variable ${ast.ref}`);
    for (const key of rest) {
      if (!record(value) || !Object.hasOwn(value, key))
        throw new Unresolved(`unknown field ${ast.ref}`);
      value = value[key];
    }
    return value;
  }
  if (ast.call) {
    const args = ast.args.map((arg) => evaluate(arg, scope));
    switch (ast.call) {
      case 'in':
        return scope.inState(String(args[0]));
      case 'min':
        return Math.min(...args);
      case 'max':
        return Math.max(...args);
      case 'abs':
        return Math.abs(args[0]);
    }
  }
  switch (ast.op) {
    case '!':
      return !evaluate(ast.arg, scope);
    case 'neg':
      return -evaluate(ast.arg, scope);
    case '&&':
      return evaluate(ast.left, scope) && evaluate(ast.right, scope);
    case '||':
      return evaluate(ast.left, scope) || evaluate(ast.right, scope);
  }
  const a = evaluate(ast.left, scope),
    b = evaluate(ast.right, scope);
  switch (ast.op) {
    case '==':
      return a === b;
    case '!=':
      return a !== b;
    case '<':
      return a < b;
    case '<=':
      return a <= b;
    case '>':
      return a > b;
    case '>=':
      return a >= b;
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      return Math.trunc(a / b);
    case '%':
      return a % b;
  }
  fail(`cannot evaluate ${JSON.stringify(ast)}`);
}

// ---------------------------------------------------------------------------
// Model normalization. Both inputs become one tree:
//   node { id, key, path, parentId, type: 'compound'|'parallel'|'atomic'|'final',
//          initialId, children[], entry[], exit[] }
//   edge { id, sourceId, targetIds[], eventType, guard, actions[], internal, order }
// ---------------------------------------------------------------------------

function normalizeXGraph(graph) {
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges))
    fail('XGraph needs nodes and edges arrays');
  const nodes = new Map();
  for (const node of graph.nodes) {
    if (!record(node.data) || typeof node.data.key !== 'string') fail(`node ${node.id} lacks data.key`);
    nodes.set(node.id, {
      id: node.id,
      key: node.data.key,
      parentId: node.parentId ?? null,
      rawType: node.data.type ?? null,
      history: node.data.history ?? false,
      initialId: node.data.initialId ?? null,
      children: [],
      entry: node.data.entry ?? [],
      exit: node.data.exit ?? [],
      always: [],
    });
  }
  const edges = graph.edges.map((edge, order) => ({
    id: edge.id,
    sourceId: edge.sourceId,
    targetIds:
      edge.data?.transitionType === 'targetless'
        ? []
        : [edge.targetId, ...(edge.data?.additionalTargetIds ?? [])].filter(Boolean),
    eventType: edge.data?.eventType ?? '',
    guard: edge.data?.guard ?? null,
    actions: edge.data?.actions ?? [],
    reenter: edge.data?.transitionType === 'reenter',
    order,
  }));
  return finishTree(nodes, edges);
}

function normalizeXStateConfig(config) {
  const nodes = new Map();
  const edges = [];
  let order = 0;
  const actions = (list) =>
    (Array.isArray(list) ? list : list ? [list] : []).map((item) =>
      typeof item === 'string' ? { type: item } : record(item) ? item : { type: String(item) },
    );
  const walk = (state, id, key, parentId) => {
    const node = {
      id,
      key,
      parentId,
      rawType: state.type ?? null,
      history: state.type === 'history' ? state.history ?? 'shallow' : false,
      initialId: state.initial != null ? `${id}.${state.initial}` : null,
      children: [],
      entry: actions(state.entry),
      exit: actions(state.exit),
      always: [],
    };
    nodes.set(id, node);
    for (const [childKey, child] of Object.entries(state.states ?? {}))
      walk(child ?? {}, `${id}.${childKey}`, childKey, id);
    const addEdges = (eventType, value) => {
      for (const item of Array.isArray(value) ? value : [value]) {
        const transition = typeof item === 'string' ? { target: item } : item ?? {};
        const targets = transition.target == null ? [] : [].concat(transition.target);
        edges.push({
          id: `${id}:${eventType}:${order}`,
          sourceId: id,
          targetIds: targets.map((target) => resolveTarget(target, id, parentId)),
          eventType,
          guard:
            transition.guard == null
              ? null
              : typeof transition.guard === 'string'
                ? { type: transition.guard }
                : transition.guard,
          actions: actions(transition.actions),
          reenter: transition.reenter === true,
          order: order++,
        });
      }
    };
    for (const [eventType, value] of Object.entries(state.on ?? {})) addEdges(eventType, value);
    if (state.always) addEdges('', state.always);
    for (const [delay, value] of Object.entries(state.after ?? {})) addEdges(`xstate.after.${delay}`, value);
    if (state.onDone) addEdges(`xstate.done.state.${id}`, state.onDone);
    for (const invoke of [].concat(state.invoke ?? [])) {
      if (invoke.onDone) addEdges(`xstate.done.actor.${invoke.id ?? invoke.src ?? 'actor'}`, invoke.onDone);
      if (invoke.onError) addEdges(`xstate.error.actor.${invoke.id ?? invoke.src ?? 'actor'}`, invoke.onError);
    }
  };
  const resolveTarget = (target, sourceId, parentId) => {
    if (target.startsWith('#')) {
      const [head, ...rest] = target.slice(1).split('.');
      const root = [...nodes.values()].find((node) => node.parentId === null);
      return [head === (config.id ?? 'machine') || head === root?.key ? rootId : head, ...rest].join('.');
    }
    if (target.startsWith('.')) return `${sourceId}${target}`;
    return parentId === null ? `${sourceId}.${target}` : `${parentId}.${target}`;
  };
  const rootId = config.id ?? 'machine';
  walk(config, rootId, rootId, null);
  // `#id` targets referring to custom state ids are rare in configs the skill handles; a
  // target that is not a known node fails closed below.
  return finishTree(nodes, edges, config.context ?? {});
}

function finishTree(nodes, edges, initialContext = {}) {
  const roots = [...nodes.values()].filter((node) => node.parentId === null);
  if (roots.length !== 1) fail('exactly one root node is required');
  const root = roots[0];
  for (const node of nodes.values()) {
    if (node.parentId === null) continue;
    const parent = nodes.get(node.parentId);
    if (!parent) fail(`node ${node.id} has unknown parent ${node.parentId}`);
    parent.children.push(node);
  }
  const paths = new Map();
  const assignPath = (node, prefix) => {
    node.path = prefix;
    paths.set(prefix.join('.'), node.id);
    for (const child of node.children) assignPath(child, [...prefix, child.key]);
  };
  assignPath(root, []);
  for (const node of nodes.values()) {
    if (node.history) fail(`history states are not supported (${node.id})`);
    if (node.rawType === 'choice') fail(`choice pseudo-states are not supported (${node.id})`);
    node.type =
      node.rawType === 'parallel'
        ? 'parallel'
        : node.rawType === 'final'
          ? 'final'
          : node.children.length
            ? 'compound'
            : 'atomic';
    if (node.type === 'compound') {
      if (node.initialId === null) node.initialId = node.children[0].id;
      if (!node.children.some((child) => child.id === node.initialId))
        fail(`initial ${node.initialId} is not a child of ${node.id}`);
    }
  }
  for (const edge of edges) {
    if (!nodes.has(edge.sourceId)) fail(`edge ${edge.id} has unknown source`);
    for (const target of edge.targetIds)
      if (!nodes.has(target)) fail(`edge ${edge.id} has unknown target ${target}`);
    if (edge.eventType === '' || edge.eventType === 'xstate.always' || edge.eventType === 'always')
      edge.eventType = '';
  }
  const outgoing = new Map();
  for (const edge of [...edges].sort((a, b) => a.order - b.order))
    outgoing.set(edge.sourceId, [...(outgoing.get(edge.sourceId) ?? []), edge]);
  // External alphabet: every edge event except eventless ones and state completion events,
  // which are raised internally when a final child becomes active.
  const events = [
    ...new Set(
      edges
        .map((edge) => edge.eventType)
        .filter((event) => event !== '' && !event.startsWith('xstate.done.state.')),
    ),
  ].sort();
  return { nodes, edges, outgoing, root, paths, events, initialContext };
}

export function normalizeModel(input) {
  if (!record(input)) fail('model must be a JSON object');
  if (Array.isArray(input.nodes) && Array.isArray(input.edges)) return normalizeXGraph(input);
  if (input.states || input.initial || input.on) return normalizeXStateConfig(input);
  fail('model is neither an XGraph (nodes/edges) nor an XState config (states/initial)');
}

// ---------------------------------------------------------------------------
// Rules file.
// ---------------------------------------------------------------------------

const RULE_KINDS = ['never', 'initially', 'eventually', 'eventually-always', 'leads-to', 'no-dead-ends', 'reachable'];

export function parseRules(input) {
  if (!record(input)) fail('rules must be a JSON object');
  for (const key of Object.keys(input))
    if (!['context', 'init', 'guards', 'actions', 'events', 'rules', 'bounds', 'fairness', 'assumptions'].includes(key))
      fail(`unknown rules key ${key}`);
  const domains = {};
  for (const [name, spec] of Object.entries(input.context ?? {})) {
    if (Array.isArray(spec)) domains[name] = { kind: 'enum', values: spec };
    else if (spec === 'bool' || spec === 'boolean') domains[name] = { kind: 'bool' };
    else if (record(spec) && Number.isInteger(spec.min) && Number.isInteger(spec.max) && spec.min <= spec.max)
      domains[name] = { kind: 'int', min: spec.min, max: spec.max };
    else fail(`context domain ${name} must be [values], "bool", or {min,max}`);
  }
  const guards = {};
  for (const [name, source] of Object.entries(input.guards ?? {})) guards[name] = parseExpression(source);
  const actions = {};
  for (const [name, assignments] of Object.entries(input.actions ?? {})) {
    if (!record(assignments)) fail(`action ${name} must map variables to expressions`);
    actions[name] = Object.entries(assignments).map(([variable, source]) => {
      if (!domains[variable]) fail(`action ${name} assigns ${variable}, which has no context domain`);
      return [variable, parseExpression(source)];
    });
  }
  const events = {};
  for (const [name, spec] of Object.entries(input.events ?? {})) {
    if (!record(spec) || !Array.isArray(spec.payloads) || !spec.payloads.length)
      fail(`event ${name} needs { payloads: [...] }`);
    events[name] = spec.payloads;
  }
  const rules = (input.rules ?? []).map((rule, index) => {
    if (!record(rule) || !RULE_KINDS.includes(rule.kind)) fail(`rule ${index} needs kind in ${RULE_KINDS.join('/')}`);
    const id = rule.id ?? `rule_${index}`;
    const compiled = { id, kind: rule.kind, description: rule.description };
    if (['never', 'initially', 'reachable', 'eventually', 'eventually-always'].includes(rule.kind))
      compiled.then = parseExpression(rule.when ?? rule.then);
    if (rule.kind === 'leads-to') {
      compiled.when = parseExpression(rule.when);
      compiled.then = parseExpression(rule.then);
    }
    if (rule.kind === 'no-dead-ends') compiled.allowFinal = rule.allowFinal !== false;
    return compiled;
  });
  if (!rules.length) fail('rules.rules must list at least one rule');
  if (new Set(rules.map((rule) => rule.id)).size !== rules.length) fail('duplicate rule ids');
  let fairness = input.fairness ?? 'weak';
  if (fairness === 'weak' || fairness === 'none') fairness = { kind: fairness };
  else if (record(fairness) && Array.isArray(fairness.weak) && fairness.weak.every((item) => typeof item === 'string'))
    fairness = { kind: 'events', events: fairness.weak };
  else fail('fairness must be "weak", "none", or { "weak": [eventTypes] }');
  const init = input.init === undefined ? [{}] : Array.isArray(input.init) ? input.init : [input.init];
  if (!init.length || !init.every(record)) fail('init must be an object or a non-empty list of objects');
  return {
    domains,
    init,
    guards,
    actions,
    events,
    rules,
    fairness,
    bounds: { maxStates: input.bounds?.maxStates ?? 50_000, maxAlwaysSteps: input.bounds?.maxAlwaysSteps ?? 50 },
    assumptions: input.assumptions ?? [],
  };
}

// ---------------------------------------------------------------------------
// Statechart semantics come from XState v6's pure transition functions. The
// checker only interns snapshots, enumerates events and searches the graph.
//   configuration = sorted list of active atomic/final node ids (native ids).
// ---------------------------------------------------------------------------

function loadXState() {
  // The spike resolves the v6 alpha through graph-tools (repo checkout) or a plain
  // `xstate` install next to the skill; a packaged skill would bundle it.
  const candidates = [
    [new URL('../../../../../packages/graph-tools/package.json', import.meta.url), 'xstate-v6'],
    [import.meta.url, 'xstate'],
  ];
  const errors = [];
  for (const [from, name] of candidates) {
    try {
      const require = createRequire(from);
      const xstate = require(name);
      if (typeof xstate.getMicrosteps !== 'function') throw new Error(`${name} is not XState v6`);
      return { ...xstate, version: require(`${name}/package.json`).version };
    } catch (error) {
      errors.push(error.message);
    }
  }
  fail(`xstate v6 (getMicrosteps) is required: ${errors.join('; ')}`);
}

class Unresolved extends Error {}

function ancestors(model, node) {
  const list = [];
  for (let current = node; current; current = model.nodes.get(current.parentId)) list.push(current);
  return list; // node first, root last
}
function activeSet(model, configuration) {
  const active = new Set();
  for (const id of configuration) for (const node of ancestors(model, model.nodes.get(id))) active.add(node.id);
  return active;
}

/**
 * Builds the XState v6 machine for a normalized model. Every state gets a synthetic
 * `#x<n>` id so native ids (which may contain dots) never collide with XState's path
 * syntax; `meta.edgeId` on each transition carries the native edge id back out.
 * Guards and actions become `to`/entry/exit functions that evaluate the rules-file
 * expressions; unknown guards read an assumption carried on the event (the driver
 * enumerates both values), unknown assigns are reported through `collector`.
 */
class Engine {
  constructor(model, rules, diagnostics) {
    this.model = model;
    this.rules = rules;
    this.diagnostics = diagnostics;
    this.xstate = loadXState();
    this.xid = new Map([...model.nodes.keys()].map((id, index) => [id, `x${index}`]));
    this.native = new Map([...this.xid].map(([id, xid]) => [xid, id]));
    this.current = null; // the pre-step configuration, for in() inside guards and actions
    this.collector = null; // { unresolved: boolean, wanted: Set<guardName> }
    this.machine = this.xstate.createMachine(this.stateConfig(model.root, true));
  }
  scope(configuration, context, event) {
    const active = activeSet(this.model, configuration);
    const model = this.model;
    return {
      vars: context,
      event,
      inState: (ref) => {
        if (active.has(ref)) return true;
        const id = model.paths.get(ref);
        if (id !== undefined) return active.has(id);
        for (const activeId of active) {
          const node = model.nodes.get(activeId);
          if (node.key === ref || node.path.join('.').endsWith(`.${ref}`)) return true;
        }
        return false;
      },
    };
  }
  guardHolds(edge, context, event) {
    const name = edge.guard?.type;
    const expression = this.rules.guards[name];
    const assume = event['@assume'] ?? {};
    const askAssumption = (label) => {
      this.diagnostics.unresolvedGuards.add(label);
      if (Object.hasOwn(assume, name ?? label)) {
        this.collector.unresolved = true;
        return assume[name ?? label];
      }
      this.collector.wanted.add(name ?? label);
      return false;
    };
    if (!expression) return askAssumption(name ?? '(inline code)');
    try {
      return Boolean(evaluate(expression, this.scope(this.current, context, event)));
    } catch (error) {
      if (!(error instanceof Unresolved)) throw error;
      return askAssumption(`${name}: ${error.message}`);
    }
  }
  applyActions(actions, context, event, ownerId) {
    let next = context;
    for (const action of actions) {
      const name = action?.type;
      const assignments = this.rules.actions[name];
      if (!assignments) {
        if (name === 'xstate.assign' || name === 'assign' || name === undefined) {
          this.diagnostics.unresolvedActions.add(name ?? '(inline code)');
          this.diagnostics.unresolvedEdges.add(ownerId);
          this.collector.unresolved = true;
        }
        continue;
      }
      const updated = { ...next };
      for (const [variable, expression] of assignments) {
        try {
          updated[variable] = evaluate(expression, this.scope(this.current, next, event));
        } catch (error) {
          if (!(error instanceof Unresolved)) throw error;
          this.diagnostics.unresolvedActions.add(`${name}: ${error.message}`);
          this.diagnostics.unresolvedEdges.add(ownerId);
          this.collector.unresolved = true;
        }
      }
      next = updated;
    }
    return next;
  }
  transitionConfig(edge) {
    const target = edge.targetIds.length ? edge.targetIds.map((id) => `#${this.xid.get(id)}`) : undefined;
    const base = { ...(target ? { target } : {}), reenter: edge.reenter, meta: { edgeId: edge.id } };
    if (!edge.guard && !edge.actions.length) return base;
    return {
      ...base,
      to: ({ context, event }) => {
        if (edge.guard && !this.guardHolds(edge, context, event)) return undefined;
        const next = edge.actions.length ? this.applyActions(edge.actions, context, event, edge.id) : context;
        return { ...base, ...(next !== context ? { context: next } : {}) };
      },
    };
  }
  stateConfig(node, root = false) {
    const config = { id: this.xid.get(node.id) };
    if (root) config.context = ({ input }) => input;
    if (node.type === 'parallel') config.type = 'parallel';
    if (node.type === 'final') config.type = 'final';
    if (node.type === 'compound') config.initial = this.model.nodes.get(node.initialId).key;
    if (node.children.length) config.states = Object.fromEntries(node.children.map((child) => [child.key, this.stateConfig(child)]));
    if (node.entry.length)
      config.entry = ({ context, event }) => {
        const next = this.applyActions(node.entry, context, event, node.id);
        return next === context ? undefined : { context: next };
      };
    if (node.exit.length)
      config.exit = ({ context, event }) => {
        const next = this.applyActions(node.exit, context, event, node.id);
        return next === context ? undefined : { context: next };
      };
    const on = {};
    for (const edge of this.model.outgoing.get(node.id) ?? []) {
      const transition = this.transitionConfig(edge);
      if (edge.eventType === '') (config.always ??= []).push(transition);
      else if (edge.eventType === `xstate.done.state.${node.id}`) (config.onDone ??= []).push(transition);
      else if (edge.eventType.startsWith('xstate.done.state.')) fail(`edge ${edge.id}: a state done event must be handled on that state`);
      else (on[edge.eventType] ??= []).push(transition);
    }
    if (Object.keys(on).length) config.on = on;
    return config;
  }
  configurationOf(snapshot) {
    return snapshot.nodes
      .map((stateNode) => this.model.nodes.get(this.native.get(stateNode.id)))
      .filter((node) => node && (node.type === 'atomic' || node.type === 'final'))
      .map((node) => node.id)
      .sort();
  }
  /** Initial snapshots for one initial context (eventless transitions already settled). */
  initial(context) {
    this.current = [];
    this.collector = { unresolved: false, wanted: new Set() };
    let snapshot, steps;
    try {
      steps = this.xstate.getInitialMicrosteps(this.machine, context);
    } catch (error) {
      if (error instanceof this.xstate.InfiniteTransitionError) fail(`eventless transitions do not settle from the initial state: ${error.message}`);
      throw error;
    }
    snapshot = steps.at(-1)[0];
    const edgeIds = steps.flatMap(([, , transitions]) => transitions.map((t) => t.meta?.edgeId).filter(Boolean));
    return { snapshot, configuration: this.configurationOf(snapshot), context: snapshot.context, edgeIds, unresolved: this.collector.unresolved };
  }
  /**
   * Macrostep results for one event from one snapshot: [{ snapshot, configuration,
   * context, edgeIds, unresolved }]. Guards without an expression are case-split by
   * rerunning with every requested assumption.
   */
  step(state, eventType, payload) {
    const results = [];
    const pending = [{}];
    const seenAssumptions = new Set();
    while (pending.length) {
      const assume = pending.shift();
      const key = JSON.stringify(assume);
      if (seenAssumptions.has(key)) continue;
      seenAssumptions.add(key);
      this.current = state.configuration;
      this.collector = { unresolved: false, wanted: new Set() };
      const event = { type: eventType, ...(payload ?? {}), ...(Object.keys(assume).length ? { '@assume': assume } : {}) };
      let microsteps;
      try {
        microsteps = this.xstate.getMicrosteps(this.machine, state.snapshot, event);
      } catch (error) {
        if (error instanceof this.xstate.InfiniteTransitionError)
          fail(`eventless transitions do not settle after ${eventType} in ${state.configuration.join(',')}: ${error.message}`);
        throw error;
      }
      if (this.collector.wanted.size) {
        for (const name of this.collector.wanted) {
          pending.push({ ...assume, [name]: true });
          pending.push({ ...assume, [name]: false });
        }
        continue;
      }
      const snapshot = microsteps.at(-1)?.[0] ?? state.snapshot;
      const edgeIds = microsteps.flatMap(([, , transitions]) => transitions.map((t) => t.meta?.edgeId).filter(Boolean));
      if (!edgeIds.length && snapshot === state.snapshot) continue; // unhandled
      results.push({
        snapshot,
        configuration: this.configurationOf(snapshot),
        context: snapshot.context,
        edgeIds,
        unresolved: this.collector.unresolved,
        assume,
      });
    }
    return results;
  }
}

// ---------------------------------------------------------------------------
// Exploration and rule evaluation.
// ---------------------------------------------------------------------------

function inDomain(domains, context) {
  for (const [name, domain] of Object.entries(domains)) {
    const value = context[name];
    if (domain.kind === 'int' && !(Number.isInteger(value) && value >= domain.min && value <= domain.max)) return false;
    if (domain.kind === 'bool' && typeof value !== 'boolean') return false;
    if (domain.kind === 'enum' && !domain.values.includes(value)) return false;
  }
  return true;
}

/**
 * Strongly connected components (Tarjan) of the explored graph restricted to `inside`
 * states, reachable from `startIds`. Returns [{ members:Set, nontrivial:boolean }].
 */
function components(byId, startIds, inside) {
  const index = new Map(),
    low = new Map(),
    onStack = new Set(),
    stack = [],
    out = [];
  let counter = 0;
  const visit = (root) => {
    const frames = [{ id: root, iterator: byId(root).steps[Symbol.iterator]() }];
    index.set(root, counter), low.set(root, counter++), stack.push(root), onStack.add(root);
    while (frames.length) {
      const frame = frames.at(-1);
      const next = frame.iterator.next();
      if (!next.done) {
        const to = next.value.to;
        if (!inside(byId(to))) continue;
        if (!index.has(to)) {
          index.set(to, counter), low.set(to, counter++), stack.push(to), onStack.add(to);
          frames.push({ id: to, iterator: byId(to).steps[Symbol.iterator]() });
        } else if (onStack.has(to)) low.set(frame.id, Math.min(low.get(frame.id), index.get(to)));
        continue;
      }
      frames.pop();
      if (frames.length) low.set(frames.at(-1).id, Math.min(low.get(frames.at(-1).id), low.get(frame.id)));
      if (low.get(frame.id) === index.get(frame.id)) {
        const members = new Set();
        let id;
        do (id = stack.pop()), onStack.delete(id), members.add(id);
        while (id !== frame.id);
        const nontrivial = [...members].some((member) => byId(member).steps.some((step) => members.has(step.to)));
        out.push({ members, nontrivial });
      }
    }
  };
  for (const id of startIds) if (inside(byId(id)) && !index.has(id)) visit(id);
  return out;
}

export function check({ model: modelInput, rules: rulesInput, modelContent, rulesContent, modelPath = 'model.json', rulesPath = 'rules.json' }) {
  const started = performance.now();
  const model = normalizeModel(modelInput);
  const rules = parseRules(rulesInput);
  const diagnostics = { unresolvedGuards: new Set(), unresolvedActions: new Set(), unresolvedEdges: new Set() };
  const engine = new Engine(model, rules, diagnostics);
  const initialContexts = rules.init.map((init) => {
    const full = { ...model.initialContext, ...init };
    for (const name of Object.keys(rules.domains))
      if (!Object.hasOwn(full, name)) fail(`context variable ${name} has a domain but no initial value (set rules.init)`);
    return full;
  });
  const project = (context) => {
    const projected = {};
    for (const name of Object.keys(rules.domains)) projected[name] = context[name];
    return projected;
  };

  const states = []; // { id, snapshot, configuration, context, initial, boundary, steps: [{to, edgeIds, event, unresolved}], unresolved }
  const index = new Map();
  const key = (configuration, context) => JSON.stringify([configuration, project(context)]);
  const intern = (item, initial = false) => {
    const k = key(item.configuration, item.context);
    let id = index.get(k);
    if (id === undefined) {
      id = `s${states.length}`;
      index.set(k, id);
      states.push({
        id,
        snapshot: item.snapshot,
        configuration: item.configuration,
        context: item.context,
        initial,
        boundary: !inDomain(rules.domains, item.context),
        steps: [],
        unresolved: false,
      });
    }
    if (initial) states[Number(id.slice(1))].initial = true;
    return id;
  };
  const byId = (id) => states[Number(id.slice(1))];
  for (const context of initialContexts) {
    const start = engine.initial(context);
    const id = intern(start, true);
    if (start.unresolved) byId(id).unresolved = true;
  }
  let complete = true;
  const eventAlphabet = model.events;
  for (let cursor = 0; cursor < states.length; cursor++) {
    const state = states[cursor];
    if (state.boundary) continue;
    if (states.length > rules.bounds.maxStates) {
      complete = false;
      break;
    }
    for (const event of eventAlphabet) {
      const payloads = rules.events[event] ?? [undefined];
      for (const payload of payloads) {
        for (const result of engine.step(state, event, payload)) {
          const to = intern(result);
          const label = payload === undefined ? event : `${event} ${JSON.stringify(payload)}`;
          if (!state.steps.some((step) => step.to === to && step.event === label && step.edgeIds.join() === result.edgeIds.join()))
            state.steps.push({ to, event: label, eventType: event, edgeIds: result.edgeIds, unresolved: result.unresolved });
        }
      }
    }
  }
  const explored = states;

  const evalIn = (state, expression) => {
    try {
      return Boolean(evaluate(expression, engine.scope(state.configuration, state.context, undefined)));
    } catch (error) {
      if (error instanceof Unresolved) return null;
      throw error;
    }
  };
  const describe = (state) => ({ state: state.configuration.map((id) => model.nodes.get(id).path.join('.')), ...project(state.context) });
  const isTerminalFinal = (state) =>
    state.configuration.every((id) => {
      const node = model.nodes.get(id);
      return node.type === 'final' && (node.parentId === model.root.id || node.parentId === null);
    });
  const enabledEvents = (state) => new Set(state.steps.map((step) => step.eventType));
  /** Under per-event weak fairness an infinite loop must not keep an enabled event waiting forever. */
  const fairLoop = (members) => {
    if (rules.fairness.kind !== 'events') return true;
    const taken = new Set();
    for (const id of members) for (const step of byId(id).steps) if (members.has(step.to)) taken.add(step.eventType);
    return rules.fairness.events.every((event) => taken.has(event) || [...members].some((id) => !enabledEvents(byId(id)).has(event)));
  };
  const shortestPath = (targetPredicate, resolvedOnly = false, from = null) => {
    const parent = new Map();
    const queue = (from ?? explored.filter((state) => state.initial).map((state) => state.id)).filter(
      (id) => !(resolvedOnly && byId(id).unresolved),
    );
    for (const id of queue) parent.set(id, null);
    while (queue.length) {
      const id = queue.shift();
      if (targetPredicate(byId(id))) {
        const path = [];
        for (let current = id; current !== null; current = parent.get(current)?.from ?? null) path.unshift(current);
        return path;
      }
      for (const step of byId(id).steps)
        if (!parent.has(step.to) && !(resolvedOnly && (step.unresolved || byId(step.to).unresolved)))
          parent.set(step.to, { from: id, step }), queue.push(step.to);
    }
    return null;
  };
  /** A cycle inside `members` starting and ending at `entry`. */
  const cycleFrom = (entry, members) => {
    const parent = new Map([[entry, null]]);
    const queue = [entry];
    while (queue.length) {
      const id = queue.shift();
      for (const step of byId(id).steps) {
        if (!members.has(step.to)) continue;
        if (step.to === entry) {
          const path = [];
          for (let current = id; current !== null; current = parent.get(current)) path.unshift(current);
          return [...path, entry];
        }
        if (!parent.has(step.to)) parent.set(step.to, id), queue.push(step.to);
      }
    }
    return null;
  };
  /**
   * Lasso search for liveness: from `startIds` through `inside` states, find a run that
   * stays inside forever and whose loop satisfies `loopBad`. Returns { path, loopStart,
   * stutters } with path from an initial state, or null.
   */
  const lasso = (startIds, inside, loopBad = () => true) => {
    const region = new Set();
    const queue = [...startIds].filter((id) => inside(byId(id)));
    for (const id of queue) region.add(id);
    while (queue.length) {
      const id = queue.shift();
      for (const step of byId(id).steps) if (inside(byId(step.to)) && !region.has(step.to)) region.add(step.to), queue.push(step.to);
    }
    const reachable = (id) => region.has(id);
    if (rules.fairness.kind === 'none') {
      const path = shortestPath((state) => reachable(state.id) && !state.boundary && loopBad(new Set([state.id])));
      return path && { path, loopStart: path.length - 1, stutters: true, stuck: false };
    }
    const dead = shortestPath((state) => reachable(state.id) && !state.boundary && !state.steps.length && loopBad(new Set([state.id])));
    if (dead) return { path: dead, loopStart: dead.length - 1, stutters: true, stuck: true };
    const bad = components(byId, [...region], (state) => reachable(state.id) && !state.boundary)
      .filter((component) => component.nontrivial && loopBad(component.members) && fairLoop(component.members));
    let best = null;
    for (const component of bad) {
      const prefix = shortestPath((state) => component.members.has(state.id));
      if (!prefix || (best && prefix.length >= best.prefix.length)) continue;
      best = { prefix, component };
    }
    if (!best) return null;
    const entry = best.prefix.at(-1);
    const cycle = cycleFrom(entry, best.component.members);
    return { path: [...best.prefix.slice(0, -1), ...cycle], loopStart: best.prefix.length - 1, stutters: false, stuck: false };
  };
  const edgeBetween = (from, to) =>
    byId(from).steps.find((step) => step.to === to && !step.unresolved) ?? byId(from).steps.find((step) => step.to === to);

  const ruleResults = [];
  const counterexamples = [];
  const anyUnresolved = diagnostics.unresolvedGuards.size + diagnostics.unresolvedActions.size > 0;
  // Unresolved guards are explored both ways (a true over-approximation, so safety that holds
  // is sound). An unresolved assignment keeps the old value, which under-approximates: no
  // safety verdict of holds is sound after one.
  const underApproximated = diagnostics.unresolvedActions.size > 0;
  const ruleKind = (rule) => (rule.kind === 'never' || rule.kind === 'initially' ? 'invariant' : rule.kind === 'no-dead-ends' ? 'deadlock' : 'property');
  const emit = (rule, outcome, reason, path) => {
    const entry = {
      id: `${ruleKind(rule)}:${rule.id}`,
      kind: ruleKind(rule),
      name: rule.id,
      outcome,
      ...(rule.description ? { description: rule.description } : {}),
      ...(reason ? { reason } : {}),
      nativeKind: rule.kind,
    };
    ruleResults.push(entry);
    if (path && outcome === 'broken') {
      const transitions = [];
      for (let i = 0; i + 1 < path.path.length; i++) {
        const step = edgeBetween(path.path[i], path.path[i + 1]);
        transitions.push(stepId(path.path[i], step));
      }
      counterexamples.push({
        id: `counterexample_${counterexamples.length}`,
        ruleId: entry.id,
        states: path.path,
        transitions,
        ...(path.loopStart !== undefined ? { loopStart: path.loopStart } : {}),
        ...(path.stutters !== undefined ? { stutters: path.stutters } : {}),
      });
    }
    return entry;
  };
  const stepId = (from, step) => `${from}>${step.to}:${step.event}:${step.edgeIds.join('+')}`;
  const unresolvedNote = () =>
    `unresolved guards/actions: ${[...diagnostics.unresolvedGuards, ...diagnostics.unresolvedActions].join('; ')}`;
  const undecidable = (expression) => explored.some((state) => evalIn(state, expression) === null);

  for (const rule of rules.rules) {
    if (rule.kind === 'never') {
      const forbidden = (state) => evalIn(state, rule.then) === true;
      // A fully resolved path proves the violation even when a shorter uncertain path exists.
      const certain = shortestPath(forbidden, true);
      const path = certain ?? shortestPath(forbidden);
      if (certain) emit(rule, 'broken', undefined, { path: certain });
      else if (path) emit(rule, 'not-checked', `a path reaches the forbidden condition but crosses ${unresolvedNote()}; it may be spurious`);
      else if (undecidable(rule.then)) emit(rule, 'not-checked', 'the predicate references unknown variables in some state');
      else if (!complete) emit(rule, 'not-checked', 'exploration hit maxStates');
      else if (underApproximated) emit(rule, 'not-checked', `an unresolved assignment kept a stale value; ${unresolvedNote()}`);
      else emit(rule, 'holds', anyUnresolved ? `holds under over-approximation of ${unresolvedNote()}` : undefined);
    } else if (rule.kind === 'initially') {
      const initials = explored.filter((state) => state.initial);
      const values = initials.map((state) => evalIn(state, rule.then));
      if (values.includes(null)) emit(rule, 'not-checked', 'the predicate references unknown variables in an initial state');
      else if (values.includes(false)) emit(rule, 'broken', 'an initial state does not satisfy the condition', { path: [initials[values.indexOf(false)].id] });
      else emit(rule, 'holds');
    } else if (rule.kind === 'reachable') {
      const goal = (state) => evalIn(state, rule.then) === true;
      if (undecidable(rule.then)) {
        emit(rule, 'not-checked', 'the predicate references unknown variables in some state');
        continue;
      }
      const certain = shortestPath(goal, true);
      const path = certain ?? shortestPath(goal);
      if (certain) emit(rule, 'holds');
      else if (path) emit(rule, 'not-checked', `only reached through ${unresolvedNote()}`);
      else if (!complete || anyUnresolved) emit(rule, 'not-checked', complete ? unresolvedNote() : 'exploration hit maxStates');
      else emit(rule, 'broken', 'no reachable state satisfies the condition');
    } else if (rule.kind === 'no-dead-ends') {
      const path = shortestPath((state) => !state.boundary && !state.steps.length && !(rule.allowFinal && isTerminalFinal(state)));
      if (path) {
        if (anyUnresolved) emit(rule, 'not-checked', `a dead end was found but ${unresolvedNote()}`);
        else emit(rule, 'broken', undefined, { path, loopStart: path.length - 1, stutters: true });
      } else if (!complete || anyUnresolved) emit(rule, 'not-checked', complete ? unresolvedNote() : 'exploration hit maxStates');
      else emit(rule, 'holds');
    } else if (rule.kind === 'eventually' || rule.kind === 'leads-to' || rule.kind === 'eventually-always') {
      if (!complete) {
        emit(rule, 'not-checked', 'exploration hit maxStates');
        continue;
      }
      if (anyUnresolved) {
        emit(rule, 'not-checked', `liveness needs fully resolved guards and actions; ${unresolvedNote()}`);
        continue;
      }
      if (undecidable(rule.then) || (rule.when && undecidable(rule.when))) {
        emit(rule, 'not-checked', 'the predicate references unknown variables in some state');
        continue;
      }
      const goal = (state) => evalIn(state, rule.then) === true;
      const startIds =
        rule.kind === 'leads-to'
          ? explored.filter((state) => evalIn(state, rule.when) === true).map((state) => state.id)
          : explored.filter((state) => state.initial).map((state) => state.id);
      const found =
        rule.kind === 'eventually-always'
          ? // <>[]P fails on a run that keeps leaving P: a loop or dead end with some state outside P.
            lasso(startIds, () => true, (members) => [...members].some((id) => !goal(byId(id))))
          : lasso(startIds, (state) => !goal(state));
      if (!found) {
        emit(rule, 'holds');
        continue;
      }
      const prefix = rule.kind === 'leads-to' ? shortestPath((state) => state.id === found.path[0]) : [found.path[0]];
      const path = [...prefix.slice(0, -1), ...found.path];
      const loopStart = found.loopStart + prefix.length - 1;
      emit(
        rule,
        'broken',
        found.stutters
          ? found.stuck
            ? 'the path ends in a dead end and stutters forever'
            : 'without fairness the path may stutter forever here'
          : 'the path loops forever without satisfying the rule',
        { path, loopStart, stutters: found.stutters },
      );
    }
  }

  const elapsedMs = performance.now() - started;
  const transitions = [];
  const transitionIds = new Set();
  for (const state of explored)
    for (const step of state.steps) {
      const id = stepId(state.id, step);
      if (transitionIds.has(id)) continue;
      transitionIds.add(id);
      transitions.push({ id, from: state.id, to: step.to, action: step.event, label: step.event, eventType: step.eventType, edgeIds: step.edgeIds, unresolved: step.unresolved });
    }
  const brokenRules = new Map();
  for (const path of counterexamples)
    for (const id of path.states.slice(-1)) brokenRules.set(id, [...(brokenRules.get(id) ?? []), path.ruleId]);
  const fairnessText =
    rules.fairness.kind === 'none'
      ? 'No fairness: any state may stutter forever, so liveness breaks at the first state where the goal does not hold.'
      : rules.fairness.kind === 'events'
        ? `Weak fairness on every transition plus per-event weak fairness for ${rules.fairness.events.join(', ')}: a loop that keeps one of these events enabled must take it.`
        : 'Weak fairness: a run never stutters forever while some transition is enabled. Liveness counterexamples are real-step loops or dead ends.';
  const assumptions = [
    'Every external event may occur in any state; unhandled events are ignored. Delays, actor completions and errors are modeled as nondeterministic events.',
    'Statechart semantics are XState v6 (pure transition functions). Guards and actions are evaluated only through the expressions supplied in the rules file; inline code is not executed.',
    fairnessText,
    'Bounded context domains act as constraints: a state outside its domain is recorded but not explored further.',
    ...(anyUnresolved ? [`Unresolved guards/actions explored both ways (over-approximation): ${unresolvedNote()}`] : []),
    ...rules.assumptions,
  ];
  const result = parseCheckResult({
    schemaVersion: 'stately.check-result.v1',
    kind: explored.length ? 'explored-configurations' : 'summary-only',
    binding: {
      artifacts: [
        artifact('model', modelPath, modelContent ?? JSON.stringify(modelInput, null, 2) + '\n'),
        artifact('scope', rulesPath, rulesContent ?? JSON.stringify(rulesInput, null, 2) + '\n'),
      ],
    },
    checker: {
      name: CHECKER_NAME,
      version: CHECKER_VERSION,
      command: ['native-check', modelPath, rulesPath],
      complete,
      bounds: {
        maxStates: rules.bounds.maxStates,
        domain: rules.domains,
        fairness: rules.fairness.kind === 'events' ? rules.fairness.events : rules.fairness.kind,
        events: eventAlphabet,
        exploredStates: explored.length,
        boundaryStates: explored.filter((state) => state.boundary).length,
        transitions: transitions.length,
        elapsedMs: Math.round(elapsedMs * 100) / 100,
        engine: `xstate@${engine.xstate.version ?? 'v6'}`,
      },
      assumptions,
      checkedAt: new Date().toISOString(),
    },
    rules: ruleResults,
    states: explored.map((state) => ({
      id: state.id,
      variables: describe(state),
      initial: state.initial,
      violations: brokenRules.get(state.id)?.filter((ruleId) => ruleId.startsWith('invariant:')) ?? [],
      nodeIds: state.configuration,
      boundary: { past: false, excluded: state.boundary },
    })),
    transitions,
    counterexamples,
  });
  return { result, model, rules, diagnostics, elapsedMs };
}
// ---------------------------------------------------------------------------
// Native graph with the attached report.
// ---------------------------------------------------------------------------

function modelToXGraph(modelInput, model) {
  if (Array.isArray(modelInput.nodes)) return structuredClone(modelInput);
  const nodes = [...model.nodes.values()].map((node) => ({
    id: node.id,
    parentId: node.parentId,
    data: {
      key: node.key,
      ...(node.type === 'parallel' ? { type: 'parallel' } : node.type === 'final' ? { type: 'final' } : {}),
      ...(node.type === 'compound' ? { initialId: node.initialId } : {}),
    },
  }));
  const edges = model.edges.map((edge) => ({
    id: edge.id,
    sourceId: edge.sourceId,
    targetId: edge.targetIds[0] ?? edge.sourceId,
    data: {
      eventType: edge.eventType || 'xstate.always',
      ...(edge.targetIds.length > 1 ? { additionalTargetIds: edge.targetIds.slice(1) } : {}),
      ...(edge.guard ? { guard: edge.guard } : {}),
      ...(edge.actions.length ? { actions: edge.actions } : {}),
      ...(edge.targetIds.length ? {} : { transitionType: 'targetless' }),
    },
  }));
  return { id: model.root.id, nodes, edges, annotations: [], data: {} };
}

export function nativeGraph({ result, model }, modelInput, { summary } = {}) {
  const graph = modelToXGraph(modelInput, model);
  graph.data ??= {};
  graph.data.meta ??= {};
  // The editor stores an explicit 'normal' type on every ordinary state; the view digest
  // must be computed over that form or the Checks panel reports the view as stale.
  for (const node of graph.nodes) if (node.data.type == null) node.data.type = 'normal';
  const states = new Map(result.states.map((state) => [state.id, state]));
  const steps = new Map(result.transitions.map((step) => [step.id, step]));
  const traces = result.counterexamples.map((trace) => ({
    id: trace.id,
    ruleId: trace.ruleId,
    states: trace.states.map((id) => ({ rawStateId: id, nodeIds: states.get(id).nodeIds, variables: states.get(id).variables })),
    steps: trace.transitions.map((id) => {
      const step = steps.get(id);
      return { id, action: step.action, edgeIds: step.edgeIds, eventTypes: [step.eventType], targetNodeIds: states.get(step.to).nodeIds };
    }),
    ...(trace.loopStart !== undefined ? { loopStart: trace.loopStart } : {}),
    ...(trace.stutters !== undefined ? { stutters: trace.stutters } : {}),
  }));
  const counts = (outcome) => result.rules.filter((rule) => rule.outcome === outcome).length;
  const report = {
    schemaVersion: 'stately.check-report.v1',
    runId: `run_${sha256(JSON.stringify([result.binding.artifacts.map((a) => a.sha256), result.rules])).slice(0, 24)}`,
    status: result.rules.some((rule) => rule.outcome === 'not-checked') || !result.checker.complete ? 'incomplete' : 'complete',
    checker: {
      name: result.checker.name,
      version: result.checker.version,
      complete: result.checker.complete,
      bounds: result.checker.bounds,
      assumptions: result.checker.assumptions,
    },
    rules: result.rules.map(({ nativeKind, ...rule }) => rule),
    traces,
    artifacts: result.binding.artifacts.map(({ role, path, sha256 }) => ({ role, path, sha256 })),
    documents: [],
    summary:
      summary ??
      `${CHECKER_NAME} explored ${result.states.length} configurations and ${result.transitions.length} steps over the native model. ${counts('holds')} rules hold, ${counts('broken')} broken, ${counts('not-checked')} not checked. Model checks do not prove application behavior.`,
    checkedAt: result.checker.checkedAt,
    applicationChecks: [],
  };
  graph.data.meta['@statelyai.checkBinding'] = { artifacts: report.artifacts };
  graph.data.meta['@statelyai.checkSummary'] = {
    schemaVersion: result.schemaVersion,
    checker: result.checker.name,
    version: result.checker.version,
    complete: result.checker.complete,
    bounds: result.checker.bounds,
    assumptions: result.checker.assumptions,
    rules: report.rules,
    states: result.states.length,
    transitions: result.transitions.length,
    partial: false,
  };
  for (const node of graph.nodes) {
    const broken = traces.filter((trace) => trace.states.at(-1).nodeIds.includes(node.id) && trace.ruleId.startsWith('invariant:'));
    if (broken.length) node.data.color = 'red';
  }
  return attachReport(graph, report);
}

export function humanReport({ result }) {
  const lines = [`# ${CHECKER_NAME} ${CHECKER_VERSION}`, ''];
  lines.push(
    `Explored ${result.states.length} configurations and ${result.transitions.length} steps in ${result.checker.bounds.elapsedMs} ms (complete: ${result.checker.complete}).`,
    '',
  );
  const states = new Map(result.states.map((state) => [state.id, state]));
  for (const rule of result.rules) {
    lines.push(`## ${rule.name} (${rule.nativeKind}): ${rule.outcome}`);
    if (rule.reason) lines.push(rule.reason);
    for (const trace of result.counterexamples.filter((item) => item.ruleId === rule.id)) {
      const steps = new Map(result.transitions.map((step) => [step.id, step]));
      trace.states.forEach((id, index) => {
        const variables = states.get(id).variables;
        const marker = trace.loopStart === index ? ' <- loop' : '';
        const via = index ? ` (${steps.get(trace.transitions[index - 1]).action})` : '';
        lines.push(`${index}.${via} ${JSON.stringify(variables)}${marker}`);
      });
      if (trace.stutters) lines.push('   ... stutters');
    }
    lines.push('');
  }
  lines.push('## Assumptions', '', ...result.checker.assumptions.map((item) => `- ${item}`), '');
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// CLI: node native-check.mjs MODEL.json RULES.json --out DIR [--json]
// ---------------------------------------------------------------------------

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, json: { type: 'boolean' } },
  });
  if (positionals.length !== 2) fail('usage: native-check MODEL.json RULES.json --out DIR');
  const [modelPath, rulesPath] = positionals;
  const modelContent = await readFile(modelPath, 'utf8');
  const rulesContent = await readFile(rulesPath, 'utf8');
  const run = check({
    model: JSON.parse(modelContent),
    rules: JSON.parse(rulesContent),
    modelContent,
    rulesContent,
    modelPath: basename(modelPath),
    rulesPath: basename(rulesPath),
  });
  const graph = nativeGraph(run, JSON.parse(modelContent));
  if (values.out) {
    await mkdir(values.out, { recursive: true });
    await writeFile(join(values.out, 'check-result.json'), JSON.stringify(run.result, null, 2) + '\n');
    await writeFile(join(values.out, 'graph.json'), JSON.stringify(graph, null, 2) + '\n');
    await writeFile(join(values.out, 'check-report.json'), JSON.stringify(graph.data.meta['@statelyai.checkReport'], null, 2) + '\n');
    await writeFile(join(values.out, 'report.md'), humanReport(run));
  }
  if (values.json)
    console.log(JSON.stringify({ rules: run.result.rules, states: run.result.states.length, transitions: run.result.transitions.length, elapsedMs: run.result.checker.bounds.elapsedMs, out: values.out }, null, 2));
  else process.stdout.write(humanReport(run));
  return run.result.rules.some((rule) => rule.outcome === 'broken') ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
