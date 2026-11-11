#!/usr/bin/env node
// Generate a TLA+ module and TLC config from the native checker's inputs (a model
// in XGraph or XState config form plus a rules file), so the same model and rules
// can be checked by TLC. See references/formal-checking.md, "Export a native model".
//
// The statechart semantics are derived from the normalized tree, mirroring the
// XState v6 pure transition algorithm the native checker runs:
//   - external events select transitions tree-wise (active child first, then the
//     node's own handlers; a parallel node consults its own handlers only when no
//     region selected anything); within a node, document order, first true guard;
//   - eventless transitions select per active atomic node, walking up;
//   - exit set = active descendants of the transition domain, entry set is static;
//   - one macrostep = event transitions, then eventless transitions and queued
//     state-completion events until nothing is enabled, all in one TLA+ action.
// Anything that cannot be encoded faithfully is rejected with an error.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { normalizeModel, parseRules } from './native-check.mjs';

export const EXPORTER_NAME = 'stately-native-tla-export';
export const EXPORTER_VERSION = '1.0.0';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) {
  throw new Error(`native-tla-export: ${message}`);
}

// ---------------------------------------------------------------------------
// TLA+ lexical helpers.
// ---------------------------------------------------------------------------

const RESERVED = new Set([
  'ASSUME', 'ASSUMPTION', 'AXIOM', 'BOOLEAN', 'BY', 'CASE', 'CHOOSE', 'CONSTANT', 'CONSTANTS', 'COROLLARY',
  'DEF', 'DEFINE', 'DEFS', 'DOMAIN', 'ELSE', 'ENABLED', 'EXCEPT', 'EXTENDS', 'FALSE', 'HAVE', 'HIDE', 'IF',
  'IN', 'INSTANCE', 'LAMBDA', 'LEMMA', 'LET', 'LOCAL', 'MODULE', 'NEW', 'OBVIOUS', 'OMITTED', 'ONLY', 'OTHER',
  'PICK', 'PROOF', 'PROPOSITION', 'PROVE', 'QED', 'RECURSIVE', 'SF_', 'STATE', 'STRING', 'SUBSET', 'SUFFICES',
  'TAKE', 'TEMPORAL', 'THEN', 'THEOREM', 'TRUE', 'UNCHANGED', 'UNION', 'USE', 'VARIABLE', 'VARIABLES', 'WF_',
  'WITH', 'WITNESS', 'Nat', 'Int', 'Seq', 'Len', 'Head', 'Tail', 'Append', 'Cardinality', 'Assert', 'Print',
]);
// Names the module defines itself; user variables must not collide with them.
const MODULE_NAMES = new Set([
  'conf', 'vars', 'Ctx', 'Nodes', 'Atomic', 'Below', 'Active', 'ActiveNodes', 'Terminal', 'InFinal', 'JsDiv',
  'JsMod', 'Min', 'Max', 'Abs', 'InDomain', 'Init', 'Next', 'Spec', 'Fire', 'Settle', 'Done', 'ExitChain',
  'EntryChain', 'ActChain', 'Raised', 'SelAlways', 'SelQueue', 'Bound', 'InitConf', 'InitNodes', 'InitContexts',
  'EExit', 'EEnter', 'EEnterNodes', 'EBelow', 'ev', 'pre', 'cf', 'cf2', 'c', 'n', 'a', 'b', 'd', 'S', 'A', 'r', 'f',
  'q', 'k', 'i', 'inner', 'exited', 'entered', 'dev', 'sel',
]);
// Bound names the module uses internally (LET chains, quantifiers); user variables are renamed away from them.
const isInternal = (name) => MODULE_NAMES.has(name) || /^[cqr][0-9]+$/.test(name) || /^(Sel_|Act_|Entry_|Exit_|Payloads_|E_|N[0-9])/.test(name);

const str = (value) => `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const set = (items) => (items.length ? `{${items.join(', ')}}` : '{}');
const strSet = (items) => set(items.map(str));
const identifier = (name) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && !/^[0-9_]/.test(name) && !RESERVED.has(name) && !/^(WF_|SF_)/.test(name);
const sanitize = (name) => name.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(?=[0-9])/, '_') || 'x';
/** A TLA+ module name derived from a file or model name. */
export const moduleName = (name) => sanitize(name).replace(/^_/, 'M');

function tlaValue(value, where) {
  if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) fail(`${where}: TLA+ has no real numbers (${value})`);
    return value < 0 ? `(${value})` : String(value);
  }
  if (typeof value === 'string') return str(value);
  if (Array.isArray(value)) return `<<${value.map((item, i) => tlaValue(item, `${where}[${i}]`)).join(', ')}>>`;
  if (record(value)) {
    const fields = Object.entries(value);
    if (!fields.length) fail(`${where}: an empty record has no TLA+ form`);
    return `[${fields.map(([key, item]) => {
      if (!identifier(key)) fail(`${where}: field ${key} is not a TLA+ identifier`);
      return `${key} |-> ${tlaValue(item, `${where}.${key}`)}`;
    }).join(', ')}]`;
  }
  fail(`${where}: cannot encode ${JSON.stringify(value)}`);
}

// ---------------------------------------------------------------------------
// Expression translation with light typing. Types: 'int' | 'bool' | 'string' | null.
// ---------------------------------------------------------------------------

function translate(ast, env, where) {
  const t = (node) => translate(node, env, where);
  const typed = (node) => inferType(node, env, where);
  const needBool = (node, what) => {
    const type = typed(node);
    if (type !== null && type !== 'bool') fail(`${where}: ${what} needs a boolean, got ${type} (${JSON.stringify(node)}); JS truthiness has no TLA+ form`);
  };
  const needInt = (node, what) => {
    const type = typed(node);
    if (type !== null && type !== 'int') fail(`${where}: ${what} needs integers, got ${type}`);
  };
  if ('lit' in ast) return tlaValue(ast.lit, where);
  if (ast.cond) {
    needBool(ast.cond, 'the condition of ?:');
    return `(IF ${t(ast.cond)} THEN ${t(ast.then)} ELSE ${t(ast.otherwise)})`;
  }
  if (ast.ref) return env.ref(ast.ref, where);
  if (ast.call) {
    if (ast.call === 'in') {
      if (ast.args.length !== 1 || !('lit' in ast.args[0]) || typeof ast.args[0].lit !== 'string')
        fail(`${where}: in() takes one string literal`);
      return env.inState(ast.args[0].lit, where);
    }
    for (const arg of ast.args) needInt(arg, `${ast.call}()`);
    if (ast.call === 'abs') {
      if (ast.args.length !== 1) fail(`${where}: abs() takes one argument`);
      return `Abs(${t(ast.args[0])})`;
    }
    if (ast.args.length !== 2) fail(`${where}: ${ast.call}() takes two arguments`);
    return `${ast.call === 'min' ? 'Min' : 'Max'}(${t(ast.args[0])}, ${t(ast.args[1])})`;
  }
  switch (ast.op) {
    case '!':
      needBool(ast.arg, '!');
      return `(~${t(ast.arg)})`;
    case 'neg':
      needInt(ast.arg, 'unary minus');
      return `(-${t(ast.arg)})`;
    case '&&':
    case '||':
      needBool(ast.left, ast.op), needBool(ast.right, ast.op);
      return `(${t(ast.left)} ${ast.op === '&&' ? '/\\' : '\\/'} ${t(ast.right)})`;
    case '==':
    case '!=': {
      const a = typed(ast.left), b = typed(ast.right);
      if (a !== null && b !== null && a !== b) fail(`${where}: ${ast.op} compares ${a} with ${b}; TLC cannot compare different types`);
      return `(${t(ast.left)} ${ast.op === '==' ? '=' : '/='} ${t(ast.right)})`;
    }
    case '<':
    case '<=':
    case '>':
    case '>=':
    case '+':
    case '-':
    case '*':
      needInt(ast.left, ast.op), needInt(ast.right, ast.op);
      return `(${t(ast.left)} ${ast.op} ${t(ast.right)})`;
    case '/':
    case '%':
      needInt(ast.left, ast.op), needInt(ast.right, ast.op);
      return `${ast.op === '/' ? 'JsDiv' : 'JsMod'}(${t(ast.left)}, ${t(ast.right)})`;
  }
  fail(`${where}: cannot translate ${JSON.stringify(ast)}`);
}

function inferType(ast, env, where) {
  if ('lit' in ast) return typeof ast.lit === 'number' ? 'int' : typeof ast.lit === 'boolean' ? 'bool' : 'string';
  if (ast.cond) {
    const a = inferType(ast.then, env, where), b = inferType(ast.otherwise, env, where);
    return a === b ? a : null;
  }
  if (ast.ref) return env.typeOf(ast.ref);
  if (ast.call) return ast.call === 'in' ? 'bool' : 'int';
  if (['!', '&&', '||', '==', '!=', '<', '<=', '>', '>='].includes(ast.op)) return 'bool';
  return 'int';
}

// ---------------------------------------------------------------------------
// Static structure: document order, descendants, transition domains, entry sets.
// ---------------------------------------------------------------------------

function analyze(model) {
  const order = new Map();
  const docOrder = [];
  const visit = (node) => {
    order.set(node.id, docOrder.length);
    docOrder.push(node);
    for (const child of node.children) visit(child);
  };
  visit(model.root);
  const below = new Map(); // node id -> atomic/final descendant ids (self if leaf)
  const descendants = new Map(); // node id -> all proper descendant ids
  const fill = (node) => {
    const leaves = [];
    const inner = [];
    for (const child of node.children) {
      fill(child);
      leaves.push(...below.get(child.id));
      inner.push(child.id, ...descendants.get(child.id));
    }
    below.set(node.id, node.children.length ? leaves : [node.id]);
    descendants.set(node.id, inner);
  };
  fill(model.root);
  const isDescendant = (childId, parentId) => descendants.get(parentId).includes(childId);
  const properAncestors = (node) => {
    const list = [];
    for (let current = model.nodes.get(node.parentId); current; current = model.nodes.get(current.parentId)) list.push(current);
    return list;
  };
  // Initial descent: the nodes XState enters by default under `node`.
  const defaultEntry = (node, out) => {
    if (node.type === 'compound') {
      const initial = model.nodes.get(node.initialId);
      out.push(initial.id);
      defaultEntry(initial, out);
    } else if (node.type === 'parallel') {
      for (const child of node.children) out.push(child.id), defaultEntry(child, out);
    }
  };
  const narrowParallel = (domain, targets) => {
    let narrowed = domain;
    while (narrowed.type === 'parallel') {
      const region = narrowed.children.find((child) => targets.every((target) => target.id === child.id || isDescendant(target.id, child.id)));
      if (!region) break;
      narrowed = region;
    }
    return narrowed;
  };
  const domainOf = (edge) => {
    const source = model.nodes.get(edge.sourceId);
    const targets = edge.targetIds.map((id) => model.nodes.get(id));
    if (targets.every((target) => target.id === source.id || isDescendant(target.id, source.id)))
      return edge.reenter ? source : narrowParallel(source, targets);
    const [head, ...tail] = [...targets, source];
    for (const ancestor of properAncestors(head))
      if (tail.every((node) => isDescendant(node.id, ancestor.id))) return edge.reenter ? ancestor : narrowParallel(ancestor, targets);
    if (edge.reenter) return null;
    return narrowParallel(model.root, targets);
  };
  const edges = model.edges.map((edge) => {
    const info = { edge, index: 0, exitNodes: [], exitBelow: [], enterNodes: [], enterLeaves: [], domainId: null };
    if (!edge.targetIds.length) return info;
    const source = model.nodes.get(edge.sourceId);
    const domain = domainOf(edge);
    if (domain === null) {
      // Re-entering a transition whose LCA is the root: exits and re-enters everything.
      info.domainId = null;
      info.exitNodes = [model.root.id, ...descendants.get(model.root.id)];
      info.exitBelow = below.get(model.root.id);
    } else {
      info.domainId = domain.id;
      info.exitNodes = [...descendants.get(domain.id)];
      if (edge.reenter && source.id === domain.id) info.exitNodes.push(domain.id);
      info.exitBelow = below.get(domain.id);
    }
    const entered = new Set();
    for (const target of edge.targetIds) {
      const targetNode = model.nodes.get(target);
      if (!(target === source.id && !edge.reenter)) entered.add(target);
      const extra = [];
      defaultEntry(targetNode, extra);
      for (const id of extra) entered.add(id);
      for (const ancestor of properAncestors(targetNode)) {
        if (domain !== null && !isDescendant(ancestor.id, domain.id)) break;
        entered.add(ancestor.id);
        if (ancestor.type === 'parallel')
          for (const region of ancestor.children)
            if (!edge.targetIds.some((t) => t === region.id || isDescendant(t, region.id))) {
              entered.add(region.id);
              const more = [];
              defaultEntry(region, more);
              for (const id of more) entered.add(id);
            }
      }
    }
    info.enterNodes = [...entered].sort((a, b) => order.get(a) - order.get(b));
    info.enterLeaves = info.enterNodes.filter((id) => !model.nodes.get(id).children.length);
    return info;
  });
  edges.forEach((info, index) => (info.index = index + 1));
  const initialNodes = [];
  defaultEntry(model.root, initialNodes);
  const initial = { nodes: [model.root.id, ...initialNodes], leaves: [model.root.id, ...initialNodes].filter((id) => !model.nodes.get(id).children.length) };
  return { order, docOrder, below, descendants, isDescendant, properAncestors, edges, initial };
}

// ---------------------------------------------------------------------------
// Generator.
// ---------------------------------------------------------------------------

export function exportNativeTla({ model: modelInput, rules: rulesInput, module = 'Native' }) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(module)) fail('module name must be a TLA+ identifier');
  const started = performance.now();
  const model = normalizeModel(modelInput);
  const rules = parseRules(rulesInput);
  const shape = analyze(model);
  const lines = [];
  const emit = (...text) => lines.push(...text);

  // --- variables ------------------------------------------------------------
  const domainNames = Object.keys(rules.domains);
  const varName = new Map();
  for (const name of domainNames) {
    if (!identifier(name)) fail(`context variable ${name} is not a TLA+ identifier`);
    varName.set(name, isInternal(name) ? `${name}_` : name);
  }
  const constants = {};
  for (const [name, value] of Object.entries(model.initialContext))
    if (!domainNames.includes(name)) {
      if (!identifier(name)) fail(`context field ${name} is not a TLA+ identifier`);
      if (!['number', 'boolean', 'string'].includes(typeof value)) fail(`context field ${name} has no domain and is not a scalar`);
      constants[name] = value;
    }
  const typeOfVar = (name) => {
    const domain = rules.domains[name];
    if (domain) return domain.kind === 'int' ? 'int' : domain.kind === 'bool' ? 'bool' : domain.values.every((v) => typeof v === 'string') ? 'string' : domain.values.every((v) => typeof v === 'boolean') ? 'bool' : domain.values.every((v) => typeof v === 'number') ? 'int' : null;
    if (name in constants) return typeof constants[name] === 'number' ? 'int' : typeof constants[name] === 'boolean' ? 'bool' : 'string';
    return null;
  };

  // --- in() resolution (same lookup as the native checker's inState) -----------
  // Same precedence as the native inState: an exact id wins, then a full path, then any
  // node whose key or path suffix matches (true when any of those is active).
  const nodesMatching = (ref) => {
    if (model.nodes.has(ref)) return [ref];
    const byPath = model.paths.get(ref);
    if (byPath !== undefined) return [byPath];
    const out = new Set();
    for (const node of model.nodes.values())
      if (node.key === ref || node.path.join('.').endsWith(`.${ref}`)) out.add(node.id);
    return [...out];
  };
  const activeExpr = (confExpr, nodeId) => {
    const leaves = shape.below.get(nodeId);
    return leaves.length === 1 && leaves[0] === nodeId ? `(${str(nodeId)} \\in ${confExpr})` : `((${confExpr} \\cap ${strSet(leaves)}) /= {})`;
  };
  const inStateExpr = (confExpr) => (ref, where) => {
    const ids = nodesMatching(ref);
    if (!ids.length) fail(`${where}: in(${JSON.stringify(ref)}) matches no state`);
    return ids.length === 1 ? activeExpr(confExpr, ids[0]) : `(${ids.map((id) => activeExpr(confExpr, id)).join(' \\/ ')})`;
  };
  const payloadFields = new Map(); // event type -> Set of field names
  for (const [event, payloads] of Object.entries(rules.events)) {
    const fields = new Set();
    for (const payload of payloads) {
      if (!record(payload)) fail(`event ${event}: payloads must be objects`);
      for (const key of Object.keys(payload)) fields.add(key);
    }
    payloadFields.set(event, fields);
  }
  const envFor = ({ ctx, conf, event }) => ({
    typeOf: (ref) => {
      const [head, ...rest] = ref.split('.');
      if (head === 'event' && !domainNames.includes('event') && !(head in constants)) {
        if (rest.length !== 1 || !event) return null;
        if (rest[0] === 'type') return 'string';
        const kinds = new Set((event.type === null ? [] : rules.events[event.type] ?? []).map((p) => typeof p[rest[0]]));
        return kinds.size === 1 ? { number: 'int', boolean: 'bool', string: 'string' }[[...kinds][0]] ?? null : null;
      }
      if (rest.length) fail(`${event?.where ?? 'rule'}: dotted variable ${ref} has no TLA+ form`);
      return typeOfVar(head);
    },
    ref: (ref, where) => {
      const [head, ...rest] = ref.split('.');
      if (head === 'event' && !domainNames.includes('event') && !(head in constants)) {
        if (!event) fail(`${where}: event.${rest.join('.')} is read where no event is in scope`);
        if (rest.length !== 1) fail(`${where}: only one-level event fields are supported (${ref})`);
        if (rest[0] !== 'type' && (event.type === null || !payloadFields.get(event.type)?.has(rest[0])))
          fail(`${where}: ${ref} is read but event ${event.type ?? '(internal)'} has no payload field ${rest[0]}; the native checker would leave this unresolved`);
        if (event.type !== null && rest[0] !== 'type' && rules.events[event.type].some((p) => !Object.hasOwn(p, rest[0])))
          fail(`${where}: ${ref} is missing from some payloads of ${event.type}`);
        return `ev.${rest[0]}`;
      }
      if (rest.length) fail(`${where}: dotted variable ${ref} has no TLA+ form`);
      if (domainNames.includes(head)) return ctx === null ? varName.get(head) : `${ctx}.${varName.get(head)}`;
      if (head in constants) return head;
      fail(`${where}: unknown variable ${ref}; the native checker would leave this unresolved`);
    },
    inState: inStateExpr(conf),
  });

  // --- static node tables ---------------------------------------------------
  const nodeIds = shape.docOrder.map((node) => node.id);
  emit(`---- MODULE ${module} ----`);
  emit(`\\* Generated by ${EXPORTER_NAME} ${EXPORTER_VERSION} from the native checker model and rules.`);
  emit(`\\* Semantics: XState v6 macrosteps (see native-check.mjs); one TLA+ action per external event.`);
  emit('EXTENDS Integers, Sequences, FiniteSets, TLC', '');
  emit(`Nodes == ${strSet(nodeIds)}`);
  emit(`Below == ${nodeIds.map((id) => `(${str(id)} :> ${strSet(shape.below.get(id))})`).join(' @@ ')}`);
  emit('ActiveNodes(cf) == {n \\in Nodes : (Below[n] \\cap cf) /= {}}', '');
  const inFinalExpr = (confExpr, node) => {
    if (node.type === 'compound') {
      const finals = node.children.filter((child) => child.type === 'final');
      return finals.length ? `(${finals.map((child) => `${str(child.id)} \\in ${confExpr}`).join(' \\/ ')})` : 'FALSE';
    }
    if (node.type === 'parallel') return node.children.length ? `(${node.children.map((child) => inFinalExpr(confExpr, child)).join(' /\\ ')})` : 'TRUE';
    return node.type === 'final' ? 'TRUE' : 'FALSE';
  };
  const rootFinals = model.root.children.filter((child) => child.type === 'final').map((child) => child.id);
  emit(`Terminal(cf) == ${model.root.type === 'parallel' ? inFinalExpr('cf', model.root) : rootFinals.length ? `(cf \\subseteq ${strSet(rootFinals)})` : 'FALSE'}`, '');

  // --- expression operators ---------------------------------------------------
  emit(
    'JsDiv(a, b) == IF (a >= 0) = (b >= 0) THEN a \\div b ELSE -((-a) \\div b)',
    'JsMod(a, b) == a - b * JsDiv(a, b)',
    'Min(a, b) == IF a <= b THEN a ELSE b',
    'Max(a, b) == IF a >= b THEN a ELSE b',
    'Abs(a) == IF a >= 0 THEN a ELSE -a',
    '',
  );
  for (const [name, value] of Object.entries(constants)) emit(`${name} == ${tlaValue(value, `context.${name}`)}`);
  if (Object.keys(constants).length) emit('');

  emit(`VARIABLES conf${domainNames.map((name) => `, ${varName.get(name)}`).join('')}`);
  emit(`vars == <<conf${domainNames.map((name) => `, ${varName.get(name)}`).join('')}>>`);
  emit(domainNames.length ? `Ctx == [${domainNames.map((name) => `${varName.get(name)} |-> ${varName.get(name)}`).join(', ')}]` : 'Ctx == [none |-> 0]');
  emit('');
  const domainExpr = (domain) =>
    domain.kind === 'int' ? `${domain.min < 0 ? `(${domain.min})` : domain.min}..${domain.max}` : domain.kind === 'bool' ? 'BOOLEAN' : set(domain.values.map((v) => tlaValue(v, 'domain')));
  emit(`InDomain == ${domainNames.length ? domainNames.map((name) => `${varName.get(name)} \\in ${domainExpr(rules.domains[name])}`).join(' /\\ ') : 'TRUE'}`, '');

  // --- events and payloads -------------------------------------------------------
  const eventNames = new Map();
  const used = new Set();
  for (const event of model.events) {
    let name = `E_${sanitize(event)}`;
    while (used.has(name)) name += '_';
    used.add(name);
    eventNames.set(event, name);
  }
  for (const event of model.events) {
    const payloads = rules.events[event] ?? [{}];
    emit(`Payloads_${eventNames.get(event)} == ${set(payloads.map((payload) => tlaValue({ type: event, ...payload }, `event ${event}`)))}`);
  }
  for (const event of Object.keys(rules.events)) if (!model.events.includes(event)) fail(`event ${event} has payloads but no edge handles it`);
  emit('');

  // --- guards and action blocks ---------------------------------------------------
  const guardExpr = (edge, scope) => {
    if (!edge.guard) return 'TRUE';
    const name = edge.guard.type;
    const expression = name === undefined ? undefined : rules.guards[name];
    if (!expression) fail(`edge ${edge.id}: guard ${name ?? '(inline code)'} has no expression in rules.guards; the native checker would leave it unresolved`);
    const env = envFor({ ctx: 'c', conf: 'pre', event: { type: scope.eventType, where: `guard ${name}` } });
    const type = inferType(expression, env, `guard ${name}`);
    if (type !== null && type !== 'bool') fail(`guard ${name}: the expression is ${type}, not boolean; JS truthiness has no TLA+ form`);
    return translate(expression, env, `guard ${name}`);
  };
  const actionBlocks = (actions, owner, scope) => {
    const blocks = [];
    for (const action of actions) {
      const name = action?.type;
      const assignments = rules.actions[name];
      if (!assignments) {
        if (name === 'xstate.assign' || name === 'assign' || name === undefined)
          fail(`${owner}: action ${name ?? '(inline code)'} has no expressions in rules.actions; the native checker would leave it unresolved`);
        continue; // named actions without assignments are side effects the checker ignores
      }
      const env = envFor({ ctx: '@C@', conf: 'pre', event: { type: scope.eventType, where: `action ${name}` } });
      blocks.push(`[@C@ EXCEPT ${assignments.map(([variable, expression]) => `!.${varName.get(variable)} = ${translate(expression, env, `action ${name}.${variable}`)}`).join(', ')}]`);
    }
    return blocks;
  };
  // A sequential chain of blocks; each block reads the previous result where it says @C@
  // (TLA+ forbids rebinding a LET name, so every step gets a fresh one).
  const chain = (blocks) => {
    if (!blocks.length) return 'c';
    const lets = blocks.map((block, i) => `LET c${i + 1} == ${block.replaceAll('@C@', i === 0 ? 'c' : `c${i}`)} IN`);
    return `${lets.join(' ')} c${blocks.length}`;
  };
  const scopeFor = (edge) => ({ eventType: edge.eventType === '' ? null : edge.eventType.startsWith('xstate.done.state.') ? null : edge.eventType });
  // Entry and exit actions may run under any event, so they must not read event payloads.
  const nodeScope = { eventType: null };
  const exitNodes = shape.docOrder.filter((node) => node.exit.length).sort((a, b) => shape.order.get(b.id) - shape.order.get(a.id));
  const entryNodes = shape.docOrder.filter((node) => node.entry.length);
  const nodeName = new Map(shape.docOrder.map((node, index) => [node.id, `N${index}`]));
  for (const node of exitNodes) emit(`Exit_${nodeName.get(node.id)}(pre, c, ev) == ${chain(actionBlocks(node.exit, `exit of ${node.id}`, nodeScope))}`);
  for (const node of entryNodes) emit(`Entry_${nodeName.get(node.id)}(pre, c, ev) == ${chain(actionBlocks(node.entry, `entry of ${node.id}`, nodeScope))}`);
  const actionEdges = shape.edges.filter((info) => info.edge.actions.length);
  for (const info of actionEdges) {
    const blocks = actionBlocks(info.edge.actions, `edge ${info.edge.id}`, scopeFor(info.edge));
    emit(`Act_${info.index}(pre, c, ev) == ${chain(blocks)}`);
  }
  emit(
    `ExitChain(exited, pre, c, ev) == ${exitNodes.length ? chain(exitNodes.map((node) => `IF ${str(node.id)} \\in exited THEN Exit_${nodeName.get(node.id)}(pre, @C@, ev) ELSE @C@`)) : 'c'}`,
    `EntryChain(entered, pre, c, ev) == ${entryNodes.length ? chain(entryNodes.map((node) => `IF ${str(node.id)} \\in entered THEN Entry_${nodeName.get(node.id)}(pre, @C@, ev) ELSE @C@`)) : 'c'}`,
    `ActChain(S, pre, c, ev) == ${actionEdges.length ? chain(actionEdges.map((info) => `IF ${info.index} \\in S THEN Act_${info.index}(pre, @C@, ev) ELSE @C@`)) : 'c'}`,
    '',
  );

  // --- per-edge static sets ---------------------------------------------------------
  const seq = (items) => (items.length ? `<<${items.join(', ')}>>` : '<<>>');
  emit(`\\* Edge index -> native edge id: ${shape.edges.map((info) => `${info.index}=${info.edge.id}`).join(', ')}`);
  emit(`EExit == ${seq(shape.edges.map((info) => strSet(info.exitNodes)))}`);
  emit(`EBelow == ${seq(shape.edges.map((info) => strSet(info.exitBelow)))}`);
  emit(`EEnterNodes == ${seq(shape.edges.map((info) => strSet(info.enterNodes)))}`);
  emit(`EEnter == ${seq(shape.edges.map((info) => strSet(info.enterLeaves)))}`);
  emit('');

  // --- state completion events ---------------------------------------------------------
  // Finals in document order; each raises done for its compound parent, then for parallel
  // ancestors that are now entirely final (XState's one-microstep cascade).
  const finals = shape.docOrder.filter((node) => node.type === 'final');
  const raisedBlocks = [];
  for (const final of finals) {
    const parent = model.nodes.get(final.parentId);
    if (!parent) continue;
    const parts = [];
    if (parent.type === 'compound') parts.push(`Append(@Q@, ${str(parent.id)})`);
    const cascade = [];
    for (let marker = parent.type === 'parallel' ? parent : model.nodes.get(parent.parentId); marker && marker.type === 'parallel'; marker = model.nodes.get(marker.parentId)?.type === 'parallel' ? model.nodes.get(marker.parentId) : model.nodes.get(model.nodes.get(marker.parentId)?.parentId))
      cascade.push(marker);
    let expr = parts.length ? parts[0] : '@Q@';
    if (cascade.length) {
      // Nested IFs: each parallel ancestor is raised only if the previous ones were and it is now final.
      const level = (i, queue) => {
        if (i === cascade.length) return queue;
        const next = `r${i + 2}`;
        const guard = `${inFinalExpr('cf2', cascade[i])} /\\ ~(\\E k \\in 1..Len(${queue}) : ${queue}[k] = ${str(cascade[i].id)})`;
        return `IF ${guard} THEN (LET ${next} == Append(${queue}, ${str(cascade[i].id)}) IN ${level(i + 1, next)}) ELSE ${queue}`;
      };
      expr = `LET r1 == ${expr} IN ${level(0, 'r1')}`;
    }
    raisedBlocks.push(`IF ${str(final.id)} \\in entered THEN (${expr}) ELSE @Q@`);
  }
  // Each block reads the queue so far as @Q@; fresh LET names per step.
  emit(`Raised(entered, cf2) == ${raisedBlocks.length ? `${raisedBlocks.map((block, i) => `LET q${i + 1} == ${block.replaceAll('@Q@', i === 0 ? '<<>>' : `q${i}`)} IN`).join(' ')} q${raisedBlocks.length}` : '<<>>'}`);
  emit('');

  // --- firing a set of edges ----------------------------------------------------------
  emit(
    '\\* Fire(S, cf, pre, c, ev): exit actions (deepest first), transition actions, entry actions;',
    '\\* returns <<configuration, context, raised done events>>.',
    'Fire(S, cf, pre, c, ev) ==',
    '  LET exited == {n \\in ActiveNodes(cf) : \\E i \\in S : n \\in EExit[i]}',
    '      entered == UNION {EEnterNodes[i] : i \\in S}',
    '      cf2 == (cf \\ UNION {EBelow[i] : i \\in S}) \\cup UNION {EEnter[i] : i \\in S}',
    '      c1 == ExitChain(exited, pre, c, ev)',
    '      c2 == ActChain(S, pre, c1, ev)',
    '      c3 == EntryChain(entered, pre, c2, ev)',
    '  IN <<cf2, c3, Raised(entered, cf2)>>',
    '',
  );

  // --- transition selection ------------------------------------------------------------
  const edgesOf = (node, eventType) => shape.edges.filter((info) => info.edge.sourceId === node.id && info.edge.eventType === eventType);
  const ownSelect = (node, eventType) => {
    const candidates = edgesOf(node, eventType);
    let body = '{}';
    for (let i = candidates.length - 1; i >= 0; i--) {
      const guard = guardExpr(candidates[i].edge, { eventType: eventType.startsWith('xstate.done.state.') ? null : eventType });
      body = guard === 'TRUE' ? `{${candidates[i].index}}` : `IF ${guard} THEN {${candidates[i].index}} ELSE ${body}`;
    }
    return body;
  };
  const subtreeHas = (node, eventType) => edgesOf(node, eventType).length > 0 || node.children.some((child) => subtreeHas(child, eventType));
  // Tree selection (external and done events): operators in post-order so children are defined first.
  const treeSelectors = new Map(); // eventType -> root operator name
  const selectorName = (eventType, node) => `Sel_${eventType.startsWith('xstate.done.state.') ? `done_${sanitize(eventType.slice('xstate.done.state.'.length))}` : eventNames.get(eventType)}_${nodeName.get(node.id)}`;
  const emitTreeSelector = (eventType) => {
    const walk = (node) => {
      if (!subtreeHas(node, eventType)) return null;
      const inner = node.children.map((child) => [child, walk(child)]).filter(([, name]) => name);
      const name = selectorName(eventType, node);
      const own = ownSelect(node, eventType);
      if (!inner.length) emit(`${name}(cf, pre, c, ev) == ${own}`);
      else {
        const innerExpr = inner.length === 1
          ? `IF ${activeExpr('cf', inner[0][0].id)} THEN ${inner[0][1]}(cf, pre, c, ev) ELSE {}`
          : `UNION {${inner.map(([child, childName]) => `IF ${activeExpr('cf', child.id)} THEN ${childName}(cf, pre, c, ev) ELSE {}`).join(', ')}}`;
        emit(`${name}(cf, pre, c, ev) == LET inner == ${innerExpr} IN IF inner /= {} THEN inner ELSE ${own}`);
      }
      return name;
    };
    treeSelectors.set(eventType, walk(model.root));
  };
  const doneEvents = [...new Set(model.edges.map((edge) => edge.eventType).filter((event) => event.startsWith('xstate.done.state.')))];
  for (const event of model.events) emitTreeSelector(event);
  for (const event of doneEvents) emitTreeSelector(event);
  emit('');
  // Eventless selection: per active atomic node, walk up, first enabled always-transition.
  const alwaysWalks = [];
  for (const leaf of shape.docOrder.filter((node) => !node.children.length)) {
    const candidates = [];
    for (let current = leaf; current; current = model.nodes.get(current.parentId)) candidates.push(...edgesOf(current, ''));
    if (!candidates.length) continue;
    let body = '{}';
    for (let i = candidates.length - 1; i >= 0; i--) {
      const guard = guardExpr(candidates[i].edge, { eventType: null });
      body = guard === 'TRUE' ? `{${candidates[i].index}}` : `IF ${guard} THEN {${candidates[i].index}} ELSE ${body}`;
    }
    alwaysWalks.push(`IF ${str(leaf.id)} \\in cf THEN ${body} ELSE {}`);
  }
  emit(`SelAlways(cf, pre, c, ev) == ${alwaysWalks.length ? `UNION {${alwaysWalks.join(', ')}}` : '{}'}`);
  emit(
    `SelQueue(d, cf, pre, c, ev) == ${doneEvents.length ? `CASE ${doneEvents.map((event) => `d = ${str(event.slice('xstate.done.state.'.length))} -> ${treeSelectors.get(event)}(cf, pre, c, ev)`).join(' [] ')} [] OTHER -> {}` : '{}'}`,
    '',
  );
  // Conflicting co-selected transitions (two parallel regions whose domains overlap) use
  // XState's iterative preemption; the spike rejects models where that can arise.
  for (const a of shape.edges)
    for (const b of shape.edges) {
      if (a.index >= b.index || !a.edge.targetIds.length || !b.edge.targetIds.length) continue;
      if (a.edge.eventType !== b.edge.eventType) continue;
      const sa = a.edge.sourceId, sb = b.edge.sourceId;
      if (sa === sb || shape.isDescendant(sa, sb) || shape.isDescendant(sb, sa)) continue;
      // Both sources are active together only when their least common ancestor is parallel.
      const lca = shape.properAncestors(model.nodes.get(sa)).find((ancestor) => shape.isDescendant(sb, ancestor.id));
      if (!lca || lca.type !== 'parallel') continue;
      const da = a.domainId ?? model.root.id, db = b.domainId ?? model.root.id;
      if (da === db || shape.isDescendant(da, db) || shape.isDescendant(db, da))
        fail(`edges ${a.edge.id} and ${b.edge.id} can fire together from different regions with overlapping exit sets; XState's preemption order is not encoded`);
    }

  // --- the settle loop ---------------------------------------------------------------------
  emit(
    `Bound == ${rules.bounds.maxAlwaysSteps}`,
    '\\* Settle(cf, c, pre, ev, q, sel, n): eventless transitions first (while they change the',
    '\\* snapshot), then queued state-completion events; a terminal configuration runs every',
    '\\* exit action (XState marks the machine done). Returns <<configuration, context>>.',
    'RECURSIVE Settle(_, _, _, _, _, _, _)',
    'Settle(cf, c, pre, ev, q, sel, n) ==',
    '  IF Terminal(cf) THEN <<cf, ExitChain(ActiveNodes(cf), pre, c, ev)>>',
    '  ELSE IF n = 0 THEN <<Assert(FALSE, "eventless transitions do not settle"), c>>',
    '  ELSE LET A == IF sel THEN SelAlways(cf, pre, c, ev) ELSE {} IN',
    '    IF A /= {} THEN',
    '      LET r == Fire(A, cf, pre, c, ev) IN',
    '      Settle(r[1], r[2], pre, ev, q \\o r[3], r[1] /= cf \\/ r[2] /= c, n - 1)',
    '    ELSE IF q = <<>> THEN <<cf, c>>',
    '    ELSE LET d == Head(q)',
    '             dev == [type |-> "xstate.done.state." \\o d]',
    '             S == SelQueue(d, cf, pre, c, dev)',
    '         IN IF S = {} THEN Settle(cf, c, pre, ev, Tail(q), sel, n - 1)',
    '            ELSE LET r == Fire(S, cf, pre, c, dev) IN',
    '                 Settle(r[1], r[2], pre, dev, Tail(q) \\o r[3], TRUE, n - 1)',
    '',
  );

  // --- initial states --------------------------------------------------------------------------
  const initContexts = rules.init.map((init) => {
    const full = { ...model.initialContext, ...init };
    for (const name of domainNames) if (!Object.hasOwn(full, name)) fail(`context variable ${name} has a domain but no initial value (set rules.init)`);
    return domainNames.length ? `[${domainNames.map((name) => `${varName.get(name)} |-> ${tlaValue(full[name], `init.${name}`)}`).join(', ')}]` : '[none |-> 0]';
  });
  const assign = (expr) => domainNames.map((name) => `${varName.get(name)}' = ${expr}.${varName.get(name)}`);
  const assignInit = (expr) => domainNames.map((name) => `${varName.get(name)} = ${expr}.${varName.get(name)}`);
  emit(
    `InitConf == ${strSet(shape.initial.leaves)}`,
    `InitNodes == ${strSet(shape.initial.nodes)}`,
    `InitContexts == ${set(initContexts)}`,
    'Init ==',
    '  \\E c0 \\in InitContexts :',
    '    LET ev == [type |-> "xstate.init"]',
    '        c1 == EntryChain(InitNodes, {}, c0, ev)',
    '        f == Settle(InitConf, c1, {}, ev, Raised(InitNodes, InitConf), TRUE, Bound)',
    `    IN ${['conf = f[1]', ...assignInit('f[2]')].join(' /\\ ')}`,
    '',
  );

  // --- event actions -----------------------------------------------------------------------------
  for (const event of model.events) {
    const name = eventNames.get(event);
    emit(
      `${name} ==`,
      '  /\\ ~Terminal(conf)',
      `  /\\ \\E ev \\in Payloads_${name} :`,
      `       LET S == ${treeSelectors.get(event)}(conf, conf, Ctx, ev) IN`,
      '       /\\ S /= {}',
      '       /\\ LET r == Fire(S, conf, conf, Ctx, ev)',
      '              f == Settle(r[1], r[2], conf, ev, r[3], TRUE, Bound)',
      `          IN ${['conf\' = f[1]', ...assign('f[2]')].join(' /\\ ')}`,
    );
  }
  const deadlockRule = rules.rules.find((rule) => rule.kind === 'no-dead-ends');
  const allowFinal = deadlockRule ? deadlockRule.allowFinal : true;
  if (allowFinal) emit('Done == Terminal(conf) /\\ UNCHANGED vars');
  const nextParts = [...model.events.map((event) => eventNames.get(event)), ...(allowFinal ? ['Done'] : [])];
  emit(`Next == ${nextParts.length ? nextParts.join(' \\/ ') : 'FALSE'}`, '');
  const fairness =
    rules.fairness.kind === 'none'
      ? ''
      : rules.fairness.kind === 'weak'
        ? ' /\\ WF_vars(Next)'
        : ` /\\ WF_vars(Next)${rules.fairness.events.map((event) => {
            if (!eventNames.has(event)) fail(`fairness names event ${event}, which no edge handles`);
            return ` /\\ WF_vars(${eventNames.get(event)})`;
          }).join('')}`;
  emit(`Spec == Init /\\ [][Next]_vars${fairness}`, '');

  // --- rules -------------------------------------------------------------------------------------
  const ruleEnv = envFor({ ctx: null, conf: 'conf', event: null });
  const config = ['SPECIFICATION Spec', 'CONSTRAINT InDomain'];
  const ruleNames = new Set();
  const mapping = [];
  const invariants = [], properties = [];
  for (const rule of rules.rules) {
    const name = sanitize(rule.id);
    if (rule.kind !== 'no-dead-ends') {
      if (!identifier(name) || ruleNames.has(name) || isInternal(name)) fail(`rule id ${rule.id} does not map to a unique TLA+ identifier`);
      ruleNames.add(name);
    }
    const where = `rule ${rule.id}`;
    const pred = (ast) => {
      const type = inferType(ast, ruleEnv, where);
      if (type !== null && type !== 'bool') fail(`${where}: the predicate is ${type}, not boolean`);
      return translate(ast, ruleEnv, where);
    };
    switch (rule.kind) {
      case 'never':
        emit(`${name} == ~${pred(rule.then)}`);
        invariants.push(name);
        mapping.push({ native: `invariant:${rule.id}`, tlc: `invariant:${name}`, kind: rule.kind });
        break;
      case 'reachable':
        emit(`${name} == ~${pred(rule.then)} \\* reachable: a counterexample is the witness`);
        invariants.push(name);
        mapping.push({ native: `property:${rule.id}`, tlc: `invariant:${name}`, kind: rule.kind, invert: true });
        break;
      case 'initially':
        emit(`${name} == ${pred(rule.then)} \\* a state predicate as PROPERTY holds in the initial states only`);
        properties.push(name);
        mapping.push({ native: `invariant:${rule.id}`, tlc: `property:${name}`, kind: rule.kind });
        break;
      case 'eventually':
        emit(`${name} == <>${pred(rule.then)}`);
        properties.push(name);
        mapping.push({ native: `property:${rule.id}`, tlc: `property:${name}`, kind: rule.kind });
        break;
      case 'eventually-always':
        emit(`${name} == <>[]${pred(rule.then)}`);
        properties.push(name);
        mapping.push({ native: `property:${rule.id}`, tlc: `property:${name}`, kind: rule.kind });
        break;
      case 'leads-to':
        emit(`${name} == ${pred(rule.when)} ~> ${pred(rule.then)}`);
        properties.push(name);
        mapping.push({ native: `property:${rule.id}`, tlc: `property:${name}`, kind: rule.kind });
        break;
      case 'no-dead-ends':
        mapping.push({ native: `deadlock:${rule.id}`, tlc: 'deadlock:', kind: rule.kind });
        break;
    }
  }
  if (rules.rules.filter((rule) => rule.kind === 'no-dead-ends').length > 1) fail('only one no-dead-ends rule can map to CHECK_DEADLOCK');
  // The TLC runner names the deadlock rule NoDeadlock unless a user rule took that name.
  for (const item of mapping) if (item.kind === 'no-dead-ends') item.tlc = ruleNames.has('NoDeadlock') ? 'deadlock:CHECK_DEADLOCK' : 'deadlock:NoDeadlock';
  for (const name of invariants) config.push(`INVARIANT ${name}`);
  for (const name of properties) config.push(`PROPERTY ${name}`);
  config.push(`CHECK_DEADLOCK ${deadlockRule ? 'TRUE' : 'FALSE'}`);
  emit('====', '');
  return {
    spec: lines.join('\n'),
    config: config.join('\n') + '\n',
    manifest: {
      exporter: { name: EXPORTER_NAME, version: EXPORTER_VERSION },
      module,
      rules: mapping,
      edges: shape.edges.map((info) => ({ index: info.index, id: info.edge.id, eventType: info.edge.eventType })),
      events: Object.fromEntries(model.events.map((event) => [event, eventNames.get(event)])),
      fairness: rules.fairness.kind === 'events' ? rules.fairness.events : rules.fairness.kind,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// Reading a TLC check result back under the native rule ids.
// ---------------------------------------------------------------------------

/**
 * Maps the rules of a stately-check result produced from an exported module back
 * to the native rule ids of the rules file. A `reachable` rule is checked as a
 * negated invariant, so its TLC verdict is inverted and a TLC counterexample is
 * its witness. Every mapped TLC rule must be present in the result.
 */
export function mapTlcRules(manifest, result) {
  if (!record(manifest) || !Array.isArray(manifest.rules)) fail('manifest has no rules mapping');
  const rules = new Map((result.rules ?? []).map((rule) => [rule.id, rule]));
  const traces = new Map((result.counterexamples ?? []).map((trace) => [trace.ruleId, trace]));
  return manifest.rules.map(({ native, tlc, kind, invert }) => {
    const rule = rules.get(tlc);
    if (!rule) fail(`manifest rule ${tlc} is not in the check result; the result was not produced from this export`);
    const trace = traces.get(tlc);
    const outcome = invert ? (rule.outcome === 'broken' ? 'holds' : rule.outcome === 'holds' ? 'broken' : rule.outcome) : rule.outcome;
    return {
      id: native,
      kind: native.slice(0, native.indexOf(':')),
      name: native.slice(native.indexOf(':') + 1),
      nativeKind: kind,
      outcome,
      tlc,
      ...(rule.reason ? { reason: rule.reason } : {}),
      ...(trace ? { [invert ? 'witness' : 'counterexample']: { id: trace.id, states: trace.states.length } } : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// CLI: node native-tla.mjs MODEL.json RULES.json --out DIR [--module Name]
// ---------------------------------------------------------------------------

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, module: { type: 'string' } },
  });
  if (positionals.length !== 2 || !values.out) fail('usage: native-tla MODEL.json RULES.json --out DIR [--module Name]');
  const [modelPath, rulesPath] = positionals;
  const module = values.module ?? moduleName(basename(modelPath).replace(/\.json$/, ''));
  const result = exportNativeTla({
    model: JSON.parse(await readFile(modelPath, 'utf8')),
    rules: JSON.parse(await readFile(rulesPath, 'utf8')),
    module,
  });
  await mkdir(values.out, { recursive: true });
  await writeFile(join(values.out, `${module}.tla`), result.spec);
  await writeFile(join(values.out, `${module}.cfg`), result.config);
  await writeFile(join(values.out, 'manifest.json'), JSON.stringify(result.manifest, null, 2) + '\n');
  console.log(JSON.stringify({ module, out: values.out, elapsedMs: result.manifest.elapsedMs }));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(error.message);
      process.exit(2);
    },
  );
