#!/usr/bin/env node
// Generate a Lean 4 file from the native checker's inputs (a model in XGraph or
// XState config form plus a rules file). See references/formal-checking.md,
// "Export to Lean".
//
// The file defines the machine as Lean functions with no Mathlib dependency:
//   - `State` is a configuration bitmask (bit i = node i in document order) plus
//     a `Ctx` record with one field per bounded context variable;
//   - `step` runs one XState v6 macrostep, the same encoding as the TLA+ export
//     (native-tla.mjs): tree-wise selection, exit/transition/entry actions, then
//     eventless transitions and queued state-completion events until settled;
//   - `Reachable` is the inductive closure of the initial states under `step`,
//     where a state outside its context domains is recorded but not expanded;
//   - `summary` explores the reachable states and reports the safety verdicts
//     (never, initially, reachable, no-dead-ends) so they can be compared with
//     the native checker. Liveness rules are listed but not evaluated.
// Theorems over `Reachable` are stated in comments; proving them is a later phase.
// Anything that cannot be encoded faithfully is rejected with an error.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { mergeImplementations, normalizeModel, parseRules } from './native-check.mjs';
import { analyze, conflictingPair, enteredLater, moduleName } from './native-tla.mjs';

export const EXPORTER_NAME = 'stately-native-lean-export';
export const EXPORTER_VERSION = '0.1.0';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function fail(message) {
  throw new Error(`native-lean-export: ${message}`);
}

// ---------------------------------------------------------------------------
// Lean lexical helpers.
// ---------------------------------------------------------------------------

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** A user name as a Lean identifier; guillemets keep keywords and odd names apart. */
const name = (text) => `«${text}»`;
const leanStr = (text) =>
  `"${[...String(text)]
    .map((ch) => {
      if (ch === '\\') return '\\\\';
      if (ch === '"') return '\\"';
      if (ch === '\n') return '\\n';
      if (ch === '\t') return '\\t';
      if (ch === '\r') return '\\r';
      const code = ch.codePointAt(0);
      return code < 0x20 || code === 0x7f ? `\\x${code.toString(16).padStart(2, '0')}` : ch;
    })
    .join('')}"`;
/** Text safe inside a `--` line comment. */
const commentText = (text) => String(text).replace(/[\u0000-\u001f\u007f]/g, ' ');
const LEAN_TYPE = { int: 'Int', bool: 'Bool', string: 'String' };
const DEFAULT = { int: '(0 : Int)', bool: 'false', string: '""' };

function typeOfValue(value) {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'string') return 'string';
  if (typeof value === 'number' && Number.isInteger(value)) return 'int';
  return null;
}

function leanValue(value, where) {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'string') return leanStr(value);
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) fail(`${where}: Lean export has no real numbers (${value})`);
    return `(${value} : Int)`;
  }
  fail(`${where}: cannot encode ${JSON.stringify(value)}; only integers, booleans and strings have a Lean form`);
}

// ---------------------------------------------------------------------------
// Expression translation. Every subexpression gets a concrete type ('int' | 'bool'
// | 'string'); anything else is rejected, since Lean has no untyped values.
// ---------------------------------------------------------------------------

function compile(ast, env, where) {
  const sub = (node) => compile(node, env, where);
  const want = (node, type, what) => {
    const out = sub(node);
    if (out.type !== type) fail(`${where}: ${what} needs ${type === 'bool' ? 'a boolean' : `${type}s`}, got ${out.type}; JS truthiness and coercion have no Lean form`);
    return out.code;
  };
  if ('lit' in ast) {
    const type = typeOfValue(ast.lit);
    if (!type) fail(`${where}: the literal ${JSON.stringify(ast.lit)} has no Lean form`);
    return { code: leanValue(ast.lit, where), type };
  }
  if (ast.cond) {
    const cond = want(ast.cond, 'bool', 'the condition of ?:');
    const a = sub(ast.then), b = sub(ast.otherwise);
    if (a.type !== b.type) fail(`${where}: the branches of ?: are ${a.type} and ${b.type}`);
    return { code: `(if ${cond} then ${a.code} else ${b.code})`, type: a.type };
  }
  if (ast.ref) return env.ref(ast.ref, where);
  if (ast.call) {
    if (ast.call === 'in') {
      if (ast.args.length !== 1 || !('lit' in ast.args[0]) || typeof ast.args[0].lit !== 'string')
        fail(`${where}: in() takes one string literal`);
      return { code: env.inState(ast.args[0].lit, where), type: 'bool' };
    }
    const args = ast.args.map((arg) => want(arg, 'int', `${ast.call}()`));
    if (ast.call === 'abs') {
      if (args.length !== 1) fail(`${where}: abs() takes one argument`);
      return { code: `(iabs ${args[0]})`, type: 'int' };
    }
    if (args.length !== 2) fail(`${where}: ${ast.call}() takes two arguments`);
    return { code: `(${ast.call === 'min' ? 'imin' : 'imax'} ${args[0]} ${args[1]})`, type: 'int' };
  }
  switch (ast.op) {
    case '!':
      return { code: `(!${want(ast.arg, 'bool', '!')})`, type: 'bool' };
    case 'neg':
      return { code: `(-${want(ast.arg, 'int', 'unary minus')})`, type: 'int' };
    case '&&':
    case '||':
      return { code: `(${want(ast.left, 'bool', ast.op)} ${ast.op} ${want(ast.right, 'bool', ast.op)})`, type: 'bool' };
    case '==':
    case '!=': {
      const a = sub(ast.left), b = sub(ast.right);
      if (a.type !== b.type) fail(`${where}: ${ast.op} compares ${a.type} with ${b.type}`);
      return { code: `(${a.code} ${ast.op} ${b.code})`, type: 'bool' };
    }
    case '<':
    case '<=':
    case '>':
    case '>=':
      return { code: `(decide (${want(ast.left, 'int', ast.op)} ${ast.op} ${want(ast.right, 'int', ast.op)}))`, type: 'bool' };
    case '+':
    case '-':
    case '*':
      return { code: `(${want(ast.left, 'int', ast.op)} ${ast.op} ${want(ast.right, 'int', ast.op)})`, type: 'int' };
    case '/':
    case '%':
      return { code: `(${ast.op === '/' ? 'jsDiv' : 'jsMod'} ${want(ast.left, 'int', ast.op)} ${want(ast.right, 'int', ast.op)})`, type: 'int' };
  }
  fail(`${where}: cannot translate ${JSON.stringify(ast)}`);
}

// ---------------------------------------------------------------------------
// Generator.
// ---------------------------------------------------------------------------

export function exportNativeLean({ model: modelInput, rules: rulesInput, module = 'Native' }) {
  if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(module)) fail('module name must be a Lean identifier');
  const started = performance.now();
  const model = normalizeModel(modelInput);
  const rules = parseRules(rulesInput);
  mergeImplementations(model, rules);
  const wildcard = model.edges.find((edge) => edge.eventType === '*' || edge.eventType.endsWith('.*'));
  if (wildcard) fail(`edge ${wildcard.id}: wildcard event ${wildcard.eventType} is not supported`);
  const shape = analyze(model);
  const lines = [];
  const emit = (...text) => lines.push(...text);

  // --- bits -------------------------------------------------------------------
  const nodeIndex = new Map(shape.docOrder.map((node, index) => [node.id, index]));
  const nodeBit = (id) => 1n << BigInt(nodeIndex.get(id));
  const mask = (ids) => ids.reduce((acc, id) => acc | nodeBit(id), 0n).toString();
  const edgeBit = (info) => (1n << BigInt(info.index)).toString();
  const leaves = (id) => shape.below.get(id);
  const activeExpr = (confExpr, nodeId) => `((${confExpr} &&& ${mask(leaves(nodeId))}) != 0)`;
  const fnName = new Map(shape.docOrder.map((node, index) => [node.id, `N${index}`]));

  // --- context ------------------------------------------------------------------
  const domainNames = Object.keys(rules.domains);
  const varType = new Map();
  for (const variable of domainNames) {
    if (!IDENTIFIER.test(variable)) fail(`context variable ${variable} is not an identifier`);
    const domain = rules.domains[variable];
    let type = domain.kind === 'int' ? 'int' : domain.kind === 'bool' ? 'bool' : null;
    if (domain.kind === 'enum') {
      const types = new Set(domain.values.map(typeOfValue));
      if (types.size !== 1 || types.has(null)) fail(`context variable ${variable}: enum values must all be integers, all booleans or all strings`);
      type = [...types][0];
    }
    varType.set(variable, type);
  }
  const constants = new Map();
  for (const [field, value] of Object.entries(model.initialContext))
    if (!domainNames.includes(field) && IDENTIFIER.test(field) && typeOfValue(value)) constants.set(field, value);

  // --- event payload fields --------------------------------------------------------
  const payloadType = new Map(); // field -> type, shared by every event that carries it
  for (const [event, payloads] of Object.entries(rules.events)) {
    if (!model.events.includes(event)) fail(`event ${event} has payloads but no edge handles it`);
    for (const payload of payloads) {
      if (!record(payload)) fail(`event ${event}: payloads must be objects`);
      for (const [field, value] of Object.entries(payload)) {
        if (field === 'type') fail(`event ${event}: a payload field named type would shadow the event type`);
        if (!IDENTIFIER.test(field)) fail(`event ${event}: payload field ${field} is not an identifier`);
        const type = typeOfValue(value);
        if (!type) fail(`event ${event}: payload field ${field} must be an integer, boolean or string`);
        if (payloadType.has(field) && payloadType.get(field) !== type)
          fail(`payload field ${field} is ${payloadType.get(field)} in one event and ${type} in another; Lean events need one type per field`);
        payloadType.set(field, type);
      }
    }
  }
  const payloadFields = [...payloadType.keys()];
  const evLiteral = (typeExpr, payload = {}) =>
    `(Ev.mk ${typeExpr}${payloadFields.map((field) => ` ${Object.hasOwn(payload, field) ? leanValue(payload[field], `payload ${field}`) : DEFAULT[payloadType.get(field)]}`).join('')})`;

  // --- in() resolution (same lookup as the native checker's inState) ----------------
  const nodesMatching = (ref) => {
    if (model.nodes.has(ref)) return [ref];
    const byPath = model.paths.get(ref);
    if (byPath !== undefined) return [byPath];
    const out = new Set();
    for (const node of model.nodes.values())
      if (node.key === ref || node.path.join('.').endsWith(`.${ref}`)) out.add(node.id);
    return [...out];
  };
  const inStateExpr = (confExpr) => (ref, where) => {
    const ids = nodesMatching(ref);
    if (!ids.length) fail(`${where}: in(${JSON.stringify(ref)}) matches no state`);
    return ids.length === 1 ? activeExpr(confExpr, ids[0]) : `(${ids.map((id) => activeExpr(confExpr, id)).join(' || ')})`;
  };
  const envFor = ({ ctx, conf, event }) => ({
    ref: (ref, where) => {
      const [head, ...rest] = ref.split('.');
      if (head === 'event' && !domainNames.includes('event') && !constants.has('event')) {
        if (!event) fail(`${where}: ${ref} is read where no event is in scope`);
        if (rest.length !== 1) fail(`${where}: only one-level event fields are supported (${ref})`);
        if (rest[0] === 'type') return { code: 'ev.type', type: 'string' };
        if (event.type === null || !rules.events[event.type]?.length || rules.events[event.type].some((payload) => !Object.hasOwn(payload, rest[0])))
          fail(`${where}: ${ref} is read but not every payload of event ${event.type ?? '(internal)'} has field ${rest[0]}`);
        return { code: `ev.${name(rest[0])}`, type: payloadType.get(rest[0]) };
      }
      if (rest.length) fail(`${where}: dotted variable ${ref} has no Lean form`);
      if (domainNames.includes(head)) return { code: `${ctx}.${name(head)}`, type: varType.get(head) };
      if (constants.has(head)) return { code: `Const.${name(head)}`, type: typeOfValue(constants.get(head)) };
      fail(`${where}: unknown variable ${ref}; the native checker would leave this unresolved`);
    },
    inState: inStateExpr(conf),
  });
  const boolExpr = (ast, env, where) => {
    const out = compile(ast, env, where);
    if (out.type !== 'bool') fail(`${where}: the expression is ${out.type}, not boolean; JS truthiness has no Lean form`);
    return out.code;
  };

  // --- header and prelude ---------------------------------------------------------------
  emit(
    `-- Generated by ${EXPORTER_NAME} ${EXPORTER_VERSION} from the native checker model and rules.`,
    '-- Semantics: XState v6 macrosteps, the same encoding as the TLA+ export (native-tla.mjs).',
    '-- Lean 4 core only. Division by zero gives 0 here; the native checker marks that state',
    '-- as outside its domain.',
    `-- Node bits (document order): ${shape.docOrder.map((node, index) => `${index}=${commentText(node.id)}`).join(', ')}`,
    `-- Edge bits: ${shape.edges.map((info) => `${info.index}=${commentText(info.edge.id)}`).join(', ')}`,
    '',
    'set_option linter.unusedVariables false',
    'set_option maxRecDepth 10000',
    '',
    `namespace ${module}`,
    '',
    'def jsDiv (a b : Int) : Int :=',
    '  let q : Int := Int.ofNat (a.natAbs / b.natAbs)',
    '  if decide (a < 0) == decide (b < 0) then q else -q',
    'def jsMod (a b : Int) : Int := a - b * jsDiv a b',
    'def imin (a b : Int) : Int := if a ≤ b then a else b',
    'def imax (a b : Int) : Int := if a ≤ b then b else a',
    'def iabs (a : Int) : Int := if 0 ≤ a then a else -a',
    '',
  );
  for (const [field, value] of constants) emit(`def Const.${name(field)} : ${LEAN_TYPE[typeOfValue(value)]} := ${leanValue(value, `context.${field}`)}`);
  if (constants.size) emit('');

  emit('structure Ctx where');
  if (domainNames.length) for (const variable of domainNames) emit(`  ${name(variable)} : ${LEAN_TYPE[varType.get(variable)]}`);
  else emit('  unit : Unit');
  emit('  deriving DecidableEq, Repr', '');
  emit('structure Ev where', '  type : String');
  for (const field of payloadFields) emit(`  ${name(field)} : ${LEAN_TYPE[payloadType.get(field)]}`);
  emit('  deriving DecidableEq, Repr', '');
  emit(
    '/-- A configuration (active atomic and final states as bits) and the bounded context. -/',
    'structure State where',
    '  conf : Nat',
    '  ctx : Ctx',
    '  deriving DecidableEq, Repr',
    '',
  );

  const domainCheck = (variable) => {
    const field = `c.${name(variable)}`;
    const domain = rules.domains[variable];
    if (domain.kind === 'int') return `(decide (${leanValue(domain.min, 'domain')} ≤ ${field}) && decide (${field} ≤ ${leanValue(domain.max, 'domain')}))`;
    if (domain.kind === 'bool') return 'true';
    return `(${domain.values.map((value) => `${field} == ${leanValue(value, `domain ${variable}`)}`).join(' || ')})`;
  };
  emit(`def inDomain (c : Ctx) : Bool := ${domainNames.length ? domainNames.map(domainCheck).join(' && ') : 'true'}`, '');

  // --- static node tables -----------------------------------------------------------
  emit(
    '/-- (node bit, leaves below the node) in document order. -/',
    `def belowTable : List (Nat × Nat) := [${shape.docOrder.map((node) => `(${mask([node.id])}, ${mask(leaves(node.id))})`).join(', ')}]`,
    'def activeNodes (cf : Nat) : Nat :=',
    '  belowTable.foldl (fun acc p => if (cf &&& p.2) != 0 then acc ||| p.1 else acc) 0',
    '',
  );
  const inFinalExpr = (confExpr, node) => {
    if (node.type === 'compound') {
      const finals = node.children.filter((child) => child.type === 'final');
      return finals.length ? `(${finals.map((child) => `((${confExpr} &&& ${mask([child.id])}) != 0)`).join(' || ')})` : 'false';
    }
    if (node.type === 'parallel') return node.children.length ? `(${node.children.map((child) => inFinalExpr(confExpr, child)).join(' && ')})` : 'true';
    return node.type === 'final' ? 'true' : 'false';
  };
  const rootFinals = model.root.children.filter((child) => child.type === 'final').map((child) => child.id);
  emit(
    '/-- The machine is done: XState stops it and runs every exit action. -/',
    `def terminal (cf : Nat) : Bool := ${model.root.type === 'parallel' ? inFinalExpr('cf', model.root) : rootFinals.length ? `((cf &&& ${mask(rootFinals)}) == cf)` : 'false'}`,
    '/-- Every active state is a final child of the root (the native no-dead-ends exemption). -/',
    `def terminalFinal (cf : Nat) : Bool := ${rootFinals.length ? `((cf &&& ${mask(rootFinals)}) == cf)` : 'false'}`,
    '',
  );

  // --- guards and action blocks ---------------------------------------------------------
  const guardExpr = (edge, scope) => {
    if (!edge.guard) return 'true';
    const guard = edge.guard.type;
    const expression = guard === undefined ? undefined : rules.guards[guard];
    if (!expression) fail(`edge ${edge.id}: guard ${guard ?? '(inline code)'} has no expression in rules.guards; the native checker would leave it unresolved`);
    return boolExpr(expression, envFor({ ctx: 'c', conf: 'pre', event: { type: scope.eventType } }), `guard ${guard}`);
  };
  // Each action is one record update; every assignment reads the context before it.
  const actionBlocks = (actions, owner, scope) => {
    const blocks = [];
    for (const action of actions) {
      const actionName = action?.resolvedType ?? action?.type;
      const assignments = rules.actions[actionName];
      if (!assignments) {
        if (actionName === 'xstate.assign' || actionName === 'assign' || actionName === undefined)
          fail(`${owner}: action ${actionName ?? '(inline code)'} has no expressions in rules.actions; the native checker would leave it unresolved`);
        continue; // named actions without assignments are side effects the checker ignores
      }
      const env = envFor({ ctx: '@C@', conf: 'pre', event: { type: scope.eventType } });
      const fields = assignments.map(([variable, expression]) => {
        const where = `action ${actionName}.${variable}`;
        const out = compile(expression, env, where);
        if (out.type !== varType.get(variable)) fail(`${where}: assigns ${out.type} to ${variable}, which is ${varType.get(variable)}`);
        return `${name(variable)} := ${out.code}`;
      });
      blocks.push(`{ @C@ with ${fields.join(', ')} }`);
    }
    return blocks;
  };
  /** A sequential chain: each block reads the previous result where it says @C@. */
  const chain = (blocks) => {
    if (!blocks.length) return ['  c'];
    return [...blocks.map((block, i) => `  let c${i + 1} := ${block.replaceAll('@C@', i === 0 ? 'c' : `c${i}`)}`), `  c${blocks.length}`];
  };
  const ctxFn = (fn, body) => emit(`def ${fn} (pre : Nat) (c : Ctx) (ev : Ev) : Ctx :=`, ...body);
  const scopeFor = (edge) => ({ eventType: edge.eventType === '' || edge.eventType.startsWith('xstate.done.state.') ? null : edge.eventType });
  // Entry and exit actions may run under any event, so they must not read event payloads.
  const nodeScope = { eventType: null };
  const exitNodes = shape.docOrder.filter((node) => node.exit.length).sort((a, b) => shape.order.get(b.id) - shape.order.get(a.id));
  const entryNodes = shape.docOrder.filter((node) => node.entry.length);
  for (const node of exitNodes) ctxFn(`exit_${fnName.get(node.id)}`, chain(actionBlocks(node.exit, `exit of ${node.id}`, nodeScope)));
  for (const node of entryNodes) ctxFn(`entry_${fnName.get(node.id)}`, chain(actionBlocks(node.entry, `entry of ${node.id}`, nodeScope)));
  // Only edges that assign; XState replaces the context with each one's result.
  const actionEdges = [];
  for (const info of shape.edges) {
    const blocks = actionBlocks(info.edge.actions, `edge ${info.edge.id}`, scopeFor(info.edge));
    if (!blocks.length) continue;
    actionEdges.push(info);
    ctxFn(`act_${info.index}`, chain(blocks));
  }
  // `from` is the context each action reads: the running one for entry and exit actions,
  // the one from before the microstep (c0) for transition actions.
  const setChain = (fn, setName, items, { params = 'c', from = (input) => input } = {}) => {
    emit(`def ${fn} (${setName} pre : Nat) (${params} : Ctx) (ev : Ev) : Ctx :=`);
    if (!items.length) return emit('  c', '');
    items.forEach(([bit, call], i) => {
      const input = i === 0 ? 'c' : `c${i}`;
      emit(`  let c${i + 1} := (if (${setName} &&& ${bit}) != 0 then ${call} pre ${from(input)} ev else ${input})`);
    });
    emit(`  c${items.length}`, '');
  };
  setChain('exitChain', 'exited', exitNodes.map((node) => [mask([node.id]), `exit_${fnName.get(node.id)}`]));
  setChain('entryChain', 'entered', entryNodes.map((node) => [mask([node.id]), `entry_${fnName.get(node.id)}`]));
  setChain('actChain', 'S', actionEdges.map((info) => [edgeBit(info), `act_${info.index}`]), { params: 'c0 c', from: () => 'c0' });
  emit(`def assignEdges : Nat := ${actionEdges.reduce((acc, info) => acc | (1n << BigInt(info.index)), 0n)}`, '');

  // --- per-edge static sets ------------------------------------------------------------
  emit(
    'structure EdgeSets where',
    '  bit : Nat',
    '  exitNodes : Nat',
    '  exitLeaves : Nat',
    '  enterNodes : Nat',
    '  enterLeaves : Nat',
    '',
    `def edgeSets : List EdgeSets := [${shape.edges.map((info) => `EdgeSets.mk ${edgeBit(info)} ${mask(info.exitNodes)} ${mask(info.exitBelow)} ${mask(info.enterNodes)} ${mask(info.enterLeaves)}`).join(', ')}]`,
    'def unionOver (S : Nat) (f : EdgeSets → Nat) : Nat :=',
    '  edgeSets.foldl (fun acc e => if (S &&& e.bit) != 0 then acc ||| f e else acc) 0',
    '',
  );

  // --- state completion events ---------------------------------------------------------
  // Finals in document order; each raises done for its compound parent, then for parallel
  // ancestors that are now entirely final (XState's one-microstep cascade).
  const finals = shape.docOrder.filter((node) => node.type === 'final');
  const raisedBlocks = [];
  for (const final of finals) {
    const parent = model.nodes.get(final.parentId);
    if (!parent) continue;
    const cascade = [];
    for (let marker = parent.type === 'parallel' ? parent : model.nodes.get(parent.parentId); marker && marker.type === 'parallel'; marker = model.nodes.get(marker.parentId)?.type === 'parallel' ? model.nodes.get(marker.parentId) : model.nodes.get(model.nodes.get(marker.parentId)?.parentId))
      cascade.push(marker);
    const base = parent.type === 'compound' ? `@Q@ ++ [${nodeIndex.get(parent.id)}]` : '@Q@';
    // XState enters states in document order and checks a parallel ancestor against the
    // states entered so far, so states entered after this final do not count yet.
    const running = `(cf2 - (cf2 &&& entered &&& ${mask(enteredLater(shape, final))}))`;
    let expr = base;
    if (cascade.length) {
      const level = (i, queue) => {
        if (i === cascade.length) return queue;
        const next = `r${i + 2}`;
        const id = nodeIndex.get(cascade[i].id);
        return `(if ${inFinalExpr(running, cascade[i])} && !(${queue}.contains ${id}) then (let ${next} := ${queue} ++ [${id}]; ${level(i + 1, next)}) else ${queue})`;
      };
      expr = `(let r1 := ${base}; ${level(0, 'r1')})`;
    }
    raisedBlocks.push([mask([final.id]), expr]);
  }
  emit('/-- State-completion events raised by entering final states, as node indices in queue order. -/', 'def raised (entered cf2 : Nat) : List Nat :=');
  if (!raisedBlocks.length) emit('  []', '');
  else {
    raisedBlocks.forEach(([bit, expr], i) => {
      const input = i === 0 ? '([] : List Nat)' : `q${i}`;
      emit(`  let q${i + 1} := (if (entered &&& ${bit}) != 0 then ${expr.replaceAll('@Q@', input)} else ${input})`);
    });
    emit(`  q${raisedBlocks.length}`, '');
  }

  // --- firing a set of edges ----------------------------------------------------------
  emit(
    '/-- Exit actions (deepest first), transition actions, entry actions; returns the new',
    '    configuration, the context, the raised state-completion events, and whether XState',
    '    makes a new snapshot (states changed, or an assignment ran, even one that writes the',
    '    same value), which keeps it selecting eventless transitions. -/',
    'def fire (S cf pre : Nat) (c : Ctx) (ev : Ev) : Nat × Ctx × List Nat × Bool :=',
    '  let exited := activeNodes cf &&& unionOver S EdgeSets.exitNodes',
    '  let entered := unionOver S EdgeSets.enterNodes',
    '  let cleared := cf &&& unionOver S EdgeSets.exitLeaves',
    '  let cf2 := (cf - cleared) ||| unionOver S EdgeSets.enterLeaves',
    '  let c1 := exitChain exited pre c ev',
    '  let c2 := actChain S pre c c1 ev',
    '  let c3 := entryChain entered pre c2 ev',
    '  (cf2, c3, raised entered cf2, cf2 != cf || exited != 0 || entered != 0 || (S &&& assignEdges) != 0)',
    '',
  );

  // --- transition selection ------------------------------------------------------------
  const edgesOf = (node, eventType) => shape.edges.filter((info) => info.edge.sourceId === node.id && info.edge.eventType === eventType);
  const firstEnabled = (candidates, scope) => {
    let body = '0';
    for (let i = candidates.length - 1; i >= 0; i--) {
      const guard = guardExpr(candidates[i].edge, scope);
      body = guard === 'true' ? edgeBit(candidates[i]) : `(if ${guard} then ${edgeBit(candidates[i])} else ${body})`;
    }
    return body;
  };
  const subtreeHas = (node, eventType) => edgesOf(node, eventType).length > 0 || node.children.some((child) => subtreeHas(child, eventType));
  const isDone = (eventType) => eventType.startsWith('xstate.done.state.');
  const doneEvents = [...new Set(model.edges.map((edge) => edge.eventType).filter(isDone))];
  const eventIndex = new Map(model.events.map((event, index) => [event, index]));
  const doneNode = (eventType) => {
    const id = eventType.slice('xstate.done.state.'.length);
    if (!nodeIndex.has(id)) fail(`state completion event ${eventType} names no state`);
    return nodeIndex.get(id);
  };
  const selectorName = (eventType, node) => `${isDone(eventType) ? `selDone_${doneNode(eventType)}` : `sel_${eventIndex.get(eventType)}`}_${fnName.get(node.id)}`;
  const treeSelectors = new Map();
  const emitTreeSelector = (eventType) => {
    const scope = { eventType: isDone(eventType) ? null : eventType };
    const walk = (node) => {
      if (!subtreeHas(node, eventType)) return null;
      const inner = node.children.map((child) => [child, walk(child)]).filter(([, fn]) => fn);
      const fn = selectorName(eventType, node);
      const own = firstEnabled(edgesOf(node, eventType), scope);
      emit(`def ${fn} (cf pre : Nat) (c : Ctx) (ev : Ev) : Nat :=`);
      if (!inner.length) emit(`  ${own}`);
      else
        emit(
          `  let inner := ${inner.map(([child, childFn]) => `(if ${activeExpr('cf', child.id)} then ${childFn} cf pre c ev else 0)`).join(' ||| ')}`,
          `  if inner != 0 then inner else ${own}`,
        );
      return fn;
    };
    treeSelectors.set(eventType, walk(model.root));
  };
  for (const event of model.events) emitTreeSelector(event);
  for (const event of doneEvents) emitTreeSelector(event);
  emit('');
  const alwaysWalks = [];
  for (const leaf of shape.docOrder.filter((node) => !node.children.length)) {
    const candidates = [];
    for (let current = leaf; current; current = model.nodes.get(current.parentId)) candidates.push(...edgesOf(current, ''));
    if (!candidates.length) continue;
    alwaysWalks.push(`(if (cf &&& ${mask([leaf.id])}) != 0 then ${firstEnabled(candidates, { eventType: null })} else 0)`);
  }
  emit(
    '/-- Eventless transitions: per active atomic state, walking up, the first enabled one. -/',
    'def selAlways (cf pre : Nat) (c : Ctx) (ev : Ev) : Nat :=',
    `  ${alwaysWalks.length ? alwaysWalks.join(' ||| ') : '0'}`,
    '',
  );
  const dispatch = (subject, cases) => cases.reduceRight((rest, [test, body]) => `if ${subject} == ${test} then ${body} else ${rest}`, '0');
  emit(
    'def selQueue (d cf pre : Nat) (c : Ctx) (ev : Ev) : Nat :=',
    `  ${dispatch('d', doneEvents.map((event) => [doneNode(event), `${treeSelectors.get(event)} cf pre c ev`]))}`,
    '',
    '/-- XState v6 state-completion events all have type xstate.done.state. -/',
    'def doneEv (d : Nat) : Ev :=',
    `  ${evLiteral(leanStr('xstate.done.state'))}`,
    '',
    'def select (cf pre : Nat) (c : Ctx) (ev : Ev) : Nat :=',
    `  ${dispatch('ev.type', model.events.map((event) => [leanStr(event), `${treeSelectors.get(event)} cf pre c ev`]))}`,
    '',
  );
  const conflict = conflictingPair(model, shape);
  if (conflict)
    fail(`edges ${conflict[0].edge.id} and ${conflict[1].edge.id} can fire together with overlapping exit sets; XState's preemption order is not encoded`);

  // --- the settle loop ---------------------------------------------------------------------
  emit(
    `def bound : Nat := ${rules.bounds.maxAlwaysSteps}`,
    '',
    '/-- Eventless transitions first (while they change the snapshot), then queued',
    '    state-completion events; a terminal configuration runs every exit action.',
    '    `none` means eventless transitions did not settle within `bound` steps. -/',
    'def settle : Nat → Nat → Ctx → Nat → Ev → List Nat → Bool → Option (Nat × Ctx)',
    '  | 0, cf, c, pre, ev, _, _ =>',
    '    if terminal cf then some (cf, exitChain (activeNodes cf) pre c ev) else none',
    '  | n + 1, cf, c, pre, ev, q, sel =>',
    '    if terminal cf then some (cf, exitChain (activeNodes cf) pre c ev)',
    '    else',
    '      let A := if sel then selAlways cf pre c ev else 0',
    '      if A != 0 then',
    '        let r := fire A cf pre c ev',
    '        settle n r.1 r.2.1 pre ev (q ++ r.2.2.1) r.2.2.2',
    '      else',
    '        match q with',
    '        | [] => some (cf, c)',
    '        | d :: rest =>',
    '          let dev := doneEv d',
    '          let S := selQueue d cf pre c dev',
    '          if S == 0 then settle n cf c pre ev rest sel',
    '          else',
    '            let r := fire S cf pre c dev',
    '            settle n r.1 r.2.1 pre dev (rest ++ r.2.2.1) true',
    '',
  );

  // --- initial states and steps --------------------------------------------------------------
  const ctxLiteral = (values) => (domainNames.length ? `(Ctx.mk${domainNames.map((variable) => ` ${leanValue(values[variable], `init.${variable}`)}`).join('')})` : '(Ctx.mk ())');
  const initContexts = rules.init.map((init) => {
    const full = { ...model.initialContext, ...init };
    for (const variable of domainNames) {
      if (!Object.hasOwn(full, variable)) fail(`context variable ${variable} has a domain but no initial value (set rules.init)`);
      if (typeOfValue(full[variable]) !== varType.get(variable)) fail(`context variable ${variable} starts as ${JSON.stringify(full[variable])}, which is not ${varType.get(variable)}`);
    }
    return ctxLiteral(full);
  });
  const payloadsOf = (event) => rules.events[event] ?? [{}];
  emit(
    'inductive Step where',
    '  | ignored',
    '  | next (s : State)',
    '  | diverged',
    '  deriving DecidableEq, Repr',
    '',
    '/-- One macrostep for an external event. A done machine ignores events. An unhandled',
    '    event still runs eventless transitions, whose in() checks read the current states. -/',
    'def step (s : State) (ev : Ev) : Step :=',
    '  if terminal s.conf then Step.ignored',
    '  else',
    '    let S := select s.conf s.conf s.ctx ev',
    '    if S == 0 && selAlways s.conf s.conf s.ctx ev == 0 then Step.ignored',
    '    else',
    '      let r : Nat × Ctx × List Nat := if S == 0 then (s.conf, s.ctx, []) else',
    '        let f := fire S s.conf s.conf s.ctx ev',
    '        (f.1, f.2.1, f.2.2.1)',
    '      match settle bound r.1 r.2.1 s.conf ev r.2.2 true with',
    '      | some p => Step.next (State.mk p.1 p.2)',
    '      | none => Step.diverged',
    '',
    `def initConf : Nat := ${mask(shape.initial.leaves)}`,
    `def initNodes : Nat := ${mask(shape.initial.nodes)}`,
    `def initEv : Ev := ${evLiteral(leanStr('xstate.init'))}`,
    `def initContexts : List Ctx := [${initContexts.join(', ')}]`,
    'def start (c0 : Ctx) : Option State :=',
    '  (settle bound initConf (entryChain initNodes 0 c0 initEv) 0 initEv (raised initNodes initConf) true).map',
    '    fun p => State.mk p.1 p.2',
    '/-- One entry per initial context; `none` means startup did not settle. -/',
    'def initial : List (Option State) := initContexts.map start',
    '',
    '/-- Every external event with every payload the rules file lists. -/',
    `def events : List Ev := [${model.events.flatMap((event) => payloadsOf(event).map((payload) => evLiteral(leanStr(event), payload))).join(', ')}]`,
    '',
    '/-- States reachable from an initial state; a state outside its domains is not expanded. -/',
    'inductive Reachable : State → Prop where',
    '  | start {s : State} : some s ∈ initial → Reachable s',
    '  | next {s t : State} {e : Ev} : Reachable s → inDomain s.ctx = true → e ∈ events → step s e = Step.next t → Reachable t',
    '',
  );

  // --- rules -------------------------------------------------------------------------------------
  const ruleEnv = envFor({ ctx: 's.ctx', conf: 's.conf', event: null });
  const ruleKind = (kind) => (kind === 'never' || kind === 'initially' ? 'invariant' : kind === 'no-dead-ends' ? 'deadlock' : 'property');
  const mapping = [];
  const verdicts = [];
  rules.rules.forEach((rule, index) => {
    const where = `rule ${rule.id}`;
    const native = `${ruleKind(rule.kind)}:${rule.id}`;
    const fn = `rule_${index}`;
    const entry = { native, lean: fn, kind: rule.kind, checked: true };
    emit(`-- Rule ${commentText(rule.id)} (${rule.kind})`);
    switch (rule.kind) {
      case 'never':
        emit(`def ${fn} (s : State) : Bool := ${boolExpr(rule.then, ruleEnv, where)}`, `-- To prove: theorem ${fn}_holds : ∀ s, Reachable s → ${fn} s = false`);
        verdicts.push([native, `(if seen.any ${fn} then "broken" else "holds")`]);
        break;
      case 'initially':
        emit(`def ${fn} (s : State) : Bool := ${boolExpr(rule.then, ruleEnv, where)}`, `-- To prove: theorem ${fn}_holds : ∀ s, some s ∈ initial → ${fn} s = true`);
        verdicts.push([native, `(if inits.all ${fn} then "holds" else "broken")`]);
        break;
      case 'reachable':
        emit(`def ${fn} (s : State) : Bool := ${boolExpr(rule.then, ruleEnv, where)}`, `-- To prove: theorem ${fn}_holds : ∃ s, Reachable s ∧ ${fn} s = true`);
        verdicts.push([native, `(if seen.any ${fn} then "holds" else "broken")`]);
        break;
      case 'no-dead-ends':
        emit(
          `def ${fn} (s : State) : Bool := inDomain s.ctx && !(events.any fun e => step s e != Step.ignored)${rule.allowFinal ? ' && !terminalFinal s.conf' : ''}`,
          `-- To prove: theorem ${fn}_holds : ∀ s, Reachable s → ${fn} s = false`,
        );
        verdicts.push([native, `(if seen.any ${fn} then "broken" else "holds")`]);
        break;
      case 'eventually':
      case 'eventually-always':
      case 'leads-to':
        // Checked so the export rejects what it cannot type; not evaluated in Lean yet.
        if (rule.when) emit(`def ${fn}_when (s : State) : Bool := ${boolExpr(rule.when, ruleEnv, where)}`);
        emit(`def ${fn} (s : State) : Bool := ${boolExpr(rule.then, ruleEnv, where)}`, '-- Liveness: stated over runs; not evaluated in this file.');
        entry.checked = false;
        break;
    }
    mapping.push(entry);
  });
  emit('');

  // --- exploration and summary --------------------------------------------------------------
  emit(
    'def expand (s : State) : List Ev → List State → List State → Except String (List State × List State)',
    '  | [], queue, seen => Except.ok (queue, seen)',
    '  | e :: rest, queue, seen =>',
    '    match step s e with',
    '    | Step.ignored => expand s rest queue seen',
    '    | Step.diverged => Except.error "eventless transitions do not settle"',
    '    | Step.next t => if seen.contains t then expand s rest queue seen else expand s rest (queue ++ [t]) (seen ++ [t])',
    '',
    '/-- Breadth-first search in the native checker\'s order; `fuel` bounds the expanded states. -/',
    'def explore : Nat → List State → List State → Except String (List State)',
    '  | 0, _, _ => Except.error "exploration hit maxStates"',
    '  | _ + 1, [], seen => Except.ok seen',
    '  | n + 1, s :: queue, seen =>',
    '    if !inDomain s.ctx then explore n queue seen',
    '    else',
    '      match expand s events queue seen with',
    '      | Except.ok (queue2, seen2) => explore n queue2 seen2',
    '      | Except.error m => Except.error m',
    '',
    'def initialStates : Except String (List State) :=',
    '  initial.foldl (fun acc o => match acc, o with',
    '    | Except.ok xs, some s => Except.ok (if xs.contains s then xs else xs ++ [s])',
    '    | Except.ok _, none => Except.error "eventless transitions do not settle from the initial state"',
    '    | e, _ => e) (Except.ok [] : Except String (List State))',
    '',
    `def maxStates : Nat := ${rules.bounds.maxStates}`,
    'def fuel : Nat := maxStates + 2',
    '',
    '/-- Explored states, states outside their domains, and the safety verdicts as JSON. -/',
    'def summary : String :=',
    '  match initialStates with',
    '  | Except.error m => "{\\"error\\": \\"" ++ m ++ "\\"}"',
    '  | Except.ok inits =>',
    '    match explore fuel inits inits with',
    '    | Except.error m => "{\\"error\\": \\"" ++ m ++ "\\"}"',
    '    | Except.ok seen =>',
    '      -- The native checker stops and reports an incomplete run past maxStates.',
    '      if seen.length > maxStates then "{\\"error\\": \\"exploration hit maxStates\\"}" else',
    '      let boundary := (seen.filter fun s => !inDomain s.ctx).length',
    `      ${leanStr('{"states": ')} ++ toString seen.length ++ ${leanStr(', "boundary": ')} ++ toString boundary ++ ${leanStr(', "rules": {')}${verdicts.map(([id, verdict], i) => ` ++ ${leanStr(`${i ? ', ' : ''}${JSON.stringify(id)}: "`)} ++ ${verdict} ++ ${leanStr('"')}`).join('')} ++ ${leanStr('}}')}`,
    '',
    `end ${module}`,
    '',
  );
  return {
    source: lines.join('\n'),
    manifest: {
      exporter: { name: EXPORTER_NAME, version: EXPORTER_VERSION },
      module,
      rules: mapping,
      nodes: shape.docOrder.map((node, index) => ({ bit: index, id: node.id })),
      edges: shape.edges.map((info) => ({ bit: info.index, id: info.edge.id, eventType: info.edge.eventType })),
      events: model.events,
      elapsedMs: Math.round((performance.now() - started) * 100) / 100,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI: node native-lean.mjs MODEL.json RULES.json --out DIR [--module Name]
// ---------------------------------------------------------------------------

export async function main(argv) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: { out: { type: 'string' }, module: { type: 'string' } },
  });
  if (positionals.length !== 2 || !values.out) fail('usage: native-lean MODEL.json RULES.json --out DIR [--module Name]');
  const [modelPath, rulesPath] = positionals;
  const module = values.module ?? moduleName(basename(modelPath).replace(/\.json$/, ''));
  const result = exportNativeLean({
    model: JSON.parse(await readFile(modelPath, 'utf8')),
    rules: JSON.parse(await readFile(rulesPath, 'utf8')),
    module,
  });
  await mkdir(values.out, { recursive: true });
  await writeFile(join(values.out, `${module}.lean`), result.source);
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
