// Trace conformance: checks recorded runs of an application against a native model and
// its rules file. A run conforms when some path of the model matches every line.
// Stepping reuses the checker's engine (`prepare` in native-check.mjs), so a
// conformance run and a check run read the model the same way.

import { activeSet, addStateReferences, expressionRefs, evaluate, inDomain, parseExpression, prepare, resolveStateReference, Unresolved } from './native-check.mjs';

export const CONFORM_NAME = 'stately-native-conform';
export const CONFORM_VERSION = '0.1.0';
export const TRACE_FORMAT = 'stately.trace.v1';
export const RESULT_FORMAT = 'stately.conform-result.v1';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const SHOWN_CANDIDATES = 10;

export class TraceError extends Error {
  constructor(message, line) {
    super(line === undefined ? `trace: ${message}` : `trace line ${line}: ${message}`);
    this.code = 'TRACE';
  }
}

/** Parses JSON Lines text into the header and the ordered event and observation lines. */
export function parseTrace(text) {
  const lines = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    if (!raw.trim()) return;
    let value;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      throw new TraceError(`invalid JSON: ${error.message}`, index + 1);
    }
    if (!record(value)) throw new TraceError('each line must be a JSON object', index + 1);
    lines.push({ value, line: index + 1 });
  });
  if (!lines.length) throw new TraceError('empty trace');
  const [{ value: header, line: headerLine }, ...rest] = lines;
  if (header.format !== TRACE_FORMAT) throw new TraceError(`the first line must be a header with "format": "${TRACE_FORMAT}"`, headerLine);
  for (const key of Object.keys(header))
    if (!['format', 'name', 'source', 'init', 'actors'].includes(key)) throw new TraceError(`unknown header key ${key}`, headerLine);
  if (header.init !== undefined && !record(header.init)) throw new TraceError('init must be an object', headerLine);
  if (header.actors !== undefined) {
    if (!record(header.actors) || !Object.keys(header.actors).length) throw new TraceError('actors must map actor names to { region?, events? }', headerLine);
    for (const [name, actor] of Object.entries(header.actors)) {
      if (!record(actor)) throw new TraceError(`actor ${name} must be an object`, headerLine);
      for (const key of Object.keys(actor)) if (!['region', 'events'].includes(key)) throw new TraceError(`actor ${name}: unknown key ${key}`, headerLine);
      if (actor.region !== undefined && typeof actor.region !== 'string') throw new TraceError(`actor ${name}: region must be a state path or node id`, headerLine);
      if (actor.events !== undefined && (typeof actor.events !== 'string' || !actor.events.includes('{type}')))
        throw new TraceError(`actor ${name}: events must be a template containing {type}`, headerLine);
    }
  }
  const steps = rest.map(({ value, line }) => {
    for (const key of Object.keys(value))
      if (!['event', 'expect', 'actor', 'seq', 'at'].includes(key)) throw new TraceError(`unknown key ${key}`, line);
    if (value.event === undefined && value.expect === undefined) throw new TraceError('a line needs event or expect', line);
    if (value.event !== undefined && !(record(value.event) && typeof value.event.type === 'string' && value.event.type))
      throw new TraceError('event must be an object with a non-empty type', line);
    if (value.expect !== undefined) {
      if (!record(value.expect)) throw new TraceError('expect must be an object', line);
      for (const key of Object.keys(value.expect))
        if (!['in', 'context', 'when', 'ignored'].includes(key)) throw new TraceError(`unknown expect key ${key}`, line);
      if (value.expect.in !== undefined && !(Array.isArray(value.expect.in) && value.expect.in.every((ref) => typeof ref === 'string' && ref)))
        throw new TraceError('expect.in must be a list of state paths or node ids', line);
      if (value.expect.context !== undefined && !record(value.expect.context)) throw new TraceError('expect.context must be an object', line);
      if (value.expect.when !== undefined && typeof value.expect.when !== 'string') throw new TraceError('expect.when must be an expression string', line);
      if (value.expect.ignored !== undefined && typeof value.expect.ignored !== 'boolean') throw new TraceError('expect.ignored must be true or false', line);
      if (value.expect.ignored !== undefined && value.event === undefined) throw new TraceError('expect.ignored needs an event on the same line', line);
    }
    if (header.actors) {
      if (typeof value.actor !== 'string' || !Object.hasOwn(header.actors, value.actor))
        throw new TraceError(`actor must name one of the header's actors: ${Object.keys(header.actors).join(', ')}`, line);
    } else if (value.actor !== undefined) throw new TraceError('actor is only allowed when the header declares actors', line);
    if (value.seq !== undefined && !Number.isInteger(value.seq)) throw new TraceError('seq must be an integer', line);
    if (value.at !== undefined && typeof value.at !== 'string') throw new TraceError('at must be a "path:line" string', line);
    return { ...value, line };
  });
  const sequenced = steps.filter((step) => step.seq !== undefined);
  if (sequenced.length && sequenced.length !== steps.length) throw new TraceError('when any line has seq, every event and observation line must');
  if (new Set(sequenced.map((step) => step.seq)).size !== sequenced.length) throw new TraceError('seq values must be unique');
  if (sequenced.length) steps.sort((a, b) => a.seq - b.seq);
  return { header: { ...header, line: headerLine }, steps };
}

/** Binds trace lines to the model: renamed event types, resolved states, parsed conditions. */
function compileTrace(trace, setup) {
  const { model, rules, stateReferences } = setup;
  const actors = {};
  for (const [name, actor] of Object.entries(trace.header.actors ?? {}))
    actors[name] = {
      events: actor.events,
      region: actor.region === undefined ? undefined : resolveStateReference(model, actor.region, `trace actor ${name} region`),
    };
  const domainNames = new Set(Object.keys(rules.domains));
  const steps = trace.steps.map((step) => {
    const actor = step.actor === undefined ? undefined : actors[step.actor];
    const owner = `trace line ${step.line}`;
    const compiled = { line: step.line, seq: step.seq, actor: step.actor, at: step.at };
    if (step.event) {
      const { type, ...payload } = step.event;
      compiled.loggedType = type;
      compiled.eventType = actor?.events ? actor.events.replaceAll('{type}', type) : type;
      compiled.payload = Object.keys(payload).length ? payload : undefined;
    }
    const expect = step.expect ?? {};
    compiled.expect = expect;
    if (expect.in) compiled.in = expect.in.map((ref) => resolveStateReference(model, ref, owner, actor?.region));
    if (expect.context) {
      for (const name of Object.keys(expect.context))
        if (!domainNames.has(name)) throw new TraceError(`expect.context names ${name}, which has no context domain in the rules file`, step.line);
      compiled.context = expect.context;
    }
    if (expect.when !== undefined) {
      let ast;
      try {
        ast = parseExpression(expect.when);
      } catch (error) {
        throw new TraceError(`expect.when: ${error.message}`, step.line);
      }
      for (const ref of expressionRefs(ast))
        if (!domainNames.has(ref)) throw new TraceError(`expect.when reads ${ref}, which has no context domain in the rules file`, step.line);
      addStateReferences(model, stateReferences, ast, owner);
      compiled.when = ast;
    }
    if (expect.ignored !== undefined) compiled.ignored = expect.ignored;
    return compiled;
  });
  return { actors, steps };
}

/**
 * Checks one parsed trace. Returns { verdict, steps, warnings, divergence?, inconclusive?, witness? }.
 * The frontier holds every model state the run can be in after each line.
 */
export function conformTrace(trace, setup, { maxFrontier = 1000 } = {}) {
  const { model, rules, engine, initialContexts, project } = setup;
  const { steps } = compileTrace(trace, setup);
  const warnings = [];
  const eventTypes = new Set(model.events);
  const describe = (candidate) => ({
    state: candidate.configuration.map((id) => model.nodes.get(id).path.join('.') || id),
    context: project(candidate.context),
    ...(candidate.unresolved ? { unresolved: true } : {}),
    ...(candidate.unknown ? { unknownContext: true } : {}),
  });
  const key = (candidate) => JSON.stringify([candidate.configuration, project(candidate.context)]);
  // `unresolved`: the path used an undefined guard or assignment. `unknown`: an undefined
  // assignment ran, so the context (and every guard read after it) may be stale.
  const doubt = (candidate) => (candidate.unknown ? 2 : 0) + (candidate.unresolved ? 1 : 0);
  const add = (map, candidate) => {
    const existing = map.get(key(candidate));
    if (!existing || doubt(candidate) < doubt(existing)) map.set(key(candidate), candidate);
  };
  const unknownStop = (line, why) => ({
    verdict: 'inconclusive',
    steps: steps.length,
    warnings,
    inconclusive: {
      line,
      reason: 'unknown-context',
      message: `${why} An assignment the rules file does not define ran earlier, so later guards and context were read from stale values.`,
      unresolvedActions: [...setup.diagnostics.unresolvedActions],
    },
  });

  // Initial frontier: every initial context that matches the header's init.
  const init = trace.header.init ?? {};
  for (const name of Object.keys(init))
    if (!Object.hasOwn(rules.domains, name)) throw new TraceError(`init names ${name}, which has no context domain in the rules file`, trace.header.line);
  let frontier = new Map();
  for (const context of initialContexts) {
    if (!Object.entries(init).every(([name, value]) => same(context[name], value))) continue;
    const start = engine.initial(context);
    if (start.wanted.length)
      return {
        verdict: 'inconclusive',
        steps: steps.length,
        warnings,
        inconclusive: {
          line: trace.header.line,
          reason: 'unresolved-initial',
          message: 'Eventless transitions in the initial state read guards the rules file does not define, so the initial state is unknown.',
          unresolvedGuards: start.wanted,
        },
      };
    add(frontier, { ...start, unknown: start.unknownContext, history: null });
  }
  if (!frontier.size)
    return {
      verdict: 'diverges',
      steps: steps.length,
      warnings,
      divergence: { line: trace.header.line, reason: 'init', message: 'No initial context in the rules file matches the header init.', expected: { init }, frontier: [] },
    };

  const checks = (step) => [
    ...(step.ignored === undefined ? [] : [['ignored', (c) => c.ignored === step.ignored, false]]),
    ...(step.in ? [['in', (c) => step.in.every((id) => activeSet(model, c.configuration).has(id)), false]] : []),
    ...(step.context ? [['context', (c) => Object.entries(step.context).every(([name, value]) => same(c.context[name], value)), true]] : []),
    ...(step.when ? [['when', (c) => whenHolds(engine, step.when, c), true]] : []),
  ];
  const expected = (step) => ({ ...(step.eventType ? { event: step.eventType } : {}), ...step.expect });

  for (const step of steps) {
    const before = [...frontier.values()];
    let next = before;
    if (step.eventType) {
      if (!eventTypes.has(step.eventType))
        warnings.push({ line: step.line, kind: 'unknown-event', message: `The model has no transition for ${step.eventType}, so it ignores it in every state.` });
      const listed = rules.events[step.eventType];
      if (listed && !listed.some((payload) => same(payload, step.payload ?? {})))
        warnings.push({ line: step.line, kind: 'unexplored-payload', message: `The rules file does not list this ${step.eventType} payload, so check never explored it.` });
      next = [];
      for (const candidate of before)
        for (const result of engine.step(candidate, step.eventType, step.payload, { keepIgnored: true }))
          next.push({
            ...result,
            ignored: Boolean(result.ignored),
            unresolved: candidate.unresolved || result.unresolved,
            unknown: candidate.unknown || result.unknownContext,
            history: { line: step.line, edgeIds: result.edgeIds, ignored: Boolean(result.ignored), prev: candidate.history },
          });
    } else next = before.map((candidate) => ({ ...candidate, ignored: undefined }));
    const possible = next;
    const stale = before.some((candidate) => candidate.unknown) || possible.some((candidate) => candidate.unknown);
    for (const [field, test, relaxed] of checks(step)) {
      // Context checks cannot fail on unknown context. Undefined guards alone leave the
      // context exact, so their candidates are checked like any other.
      const kept = next.filter((candidate) => test(candidate) || (relaxed && candidate.unknown));
      if (!kept.length && stale) return unknownStop(step.line, `No model state matches expect.${field} at this line.`);
      if (!kept.length)
        return {
          verdict: 'diverges',
          steps: steps.length,
          warnings,
          divergence: {
            line: step.line,
            ...(step.seq === undefined ? {} : { seq: step.seq }),
            ...(step.actor === undefined ? {} : { actor: step.actor, loggedEvent: step.loggedType }),
            ...(step.at ? { at: step.at } : {}),
            reason: field,
            message: divergenceMessage(field, step),
            expected: expected(step),
            frontier: before.slice(0, SHOWN_CANDIDATES).map(describe),
            possible: possible.slice(0, SHOWN_CANDIDATES).map((candidate) => ({
              ...describe(candidate),
              ...(step.eventType ? { ignored: Boolean(candidate.ignored), edgeIds: candidate.edgeIds } : {}),
            })),
            ...(before.length > SHOWN_CANDIDATES || possible.length > SHOWN_CANDIDATES ? { truncated: true } : {}),
          },
        };
      next = kept;
    }
    const inside = next.filter((candidate) => inDomain(rules.domains, candidate.context));
    if (!inside.length && stale) return unknownStop(step.line, 'Every matching model state leaves its context domain at this line.');
    if (!inside.length)
      return {
        verdict: 'diverges',
        steps: steps.length,
        warnings,
        divergence: {
          line: step.line,
          ...(step.actor === undefined ? {} : { actor: step.actor, loggedEvent: step.loggedType }),
          ...(step.at ? { at: step.at } : {}),
          reason: 'out-of-domain',
          message: 'Every matching model state has a context value outside its rules-file domain. Widen the domain or check the trace.',
          expected: expected(step),
          frontier: before.slice(0, SHOWN_CANDIDATES).map(describe),
          possible: next.slice(0, SHOWN_CANDIDATES).map(describe),
        },
      };
    frontier = new Map();
    for (const candidate of inside) add(frontier, candidate);
    if (frontier.size > maxFrontier)
      return {
        verdict: 'inconclusive',
        steps: steps.length,
        warnings,
        inconclusive: { line: step.line, reason: 'frontier', message: `More than ${maxFrontier} model states match the run at this line. Add expect fields or raise --max-frontier.` },
      };
  }
  const final = [...frontier.values()];
  const resolved = final.find((candidate) => !candidate.unresolved);
  if (!resolved)
    return {
      verdict: 'inconclusive',
      steps: steps.length,
      warnings,
      inconclusive: { reason: 'unresolved', message: 'The run matches only through guards or assignments the rules file does not define.', unresolvedGuards: [...setup.diagnostics.unresolvedGuards], unresolvedActions: [...setup.diagnostics.unresolvedActions] },
      final: final.slice(0, SHOWN_CANDIDATES).map(describe),
    };
  const witness = [];
  for (let item = resolved.history; item; item = item.prev) witness.unshift({ line: item.line, edgeIds: item.edgeIds, ...(item.ignored ? { ignored: true } : {}) });
  return { verdict: 'conforms', steps: steps.length, warnings, witness, final: describe(resolved) };
}

function whenHolds(engine, ast, candidate) {
  try {
    return Boolean(evaluate(ast, engine.scope(candidate.configuration, candidate.context, undefined)));
  } catch (error) {
    if (error instanceof Unresolved) return false;
    throw error;
  }
}

function divergenceMessage(field, step) {
  const event = step.eventType ? `after ${step.eventType}` : 'at this observation';
  switch (field) {
    case 'ignored':
      return step.ignored
        ? `The app ignored ${step.eventType}, but the model takes a transition for it in every matching state.`
        : `The app reacted to ${step.eventType}, but the model ignores it in every matching state.`;
    case 'in':
      return `No matching model state is in the expected states ${event}.`;
    case 'context':
      return `No matching model state has the expected context ${event}.`;
    default:
      return `expect.when does not hold in any matching model state ${event}.`;
  }
}

/** Checks every trace against one model and rules file. */
export function conform({ model, rules, traces, xstate, maxFrontier }) {
  const results = traces.map(({ path, text, name }) => {
    // A fresh engine per trace keeps unresolved-guard diagnostics per run.
    const setup = prepare({ model, rules, xstate });
    const parsed = parseTrace(text);
    return {
      name: parsed.header.name ?? name ?? path,
      path,
      ...(parsed.header.source ? { source: parsed.header.source } : {}),
      ...(parsed.header.actors ? { actors: Object.keys(parsed.header.actors) } : {}),
      ...conformTrace(parsed, setup, { maxFrontier }),
    };
  });
  return {
    traces: results,
    summary: {
      conforms: results.filter((item) => item.verdict === 'conforms').length,
      diverges: results.filter((item) => item.verdict === 'diverges').length,
      inconclusive: results.filter((item) => item.verdict === 'inconclusive').length,
    },
  };
}

/** 0 when every trace conforms, 1 when any diverges, 2 when any is inconclusive. */
export function conformExitCode({ summary }) {
  if (summary.diverges) return 1;
  return summary.inconclusive ? 2 : 0;
}

/** One `record-app-checks` record per trace. */
export function applicationChecks({ traces }) {
  return traces.map((trace) => ({
    name: `conform: ${trace.name}`,
    status: trace.verdict === 'conforms' ? 'passed' : trace.verdict === 'diverges' ? 'failed' : 'not-run',
    summary:
      trace.verdict === 'conforms'
        ? `The recorded run (${trace.steps} lines) is a path of the model.`
        : trace.verdict === 'diverges'
          ? `Diverges at trace line ${trace.divergence.line}: ${trace.divergence.message}`
          : `Inconclusive: ${trace.inconclusive.message}`,
    ...(trace.source ? { source: trace.source } : {}),
  }));
}

export function conformReport({ traces, summary }) {
  const lines = [
    `# ${CONFORM_NAME}: ${summary.conforms} conform, ${summary.diverges} diverge, ${summary.inconclusive} inconclusive`,
    '',
  ];
  for (const trace of traces) {
    lines.push(`## ${trace.name}: ${trace.verdict}`, '', `- Trace: ${trace.path}`);
    if (trace.source) lines.push(`- Source: ${trace.source}`);
    if (trace.actors) lines.push(`- Actors: ${trace.actors.join(', ')}`);
    lines.push(`- Lines checked: ${trace.steps}`);
    if (trace.divergence) {
      const item = trace.divergence;
      lines.push(
        `- Diverges at trace line ${item.line}${item.actor ? ` (actor ${item.actor}, logged ${item.loggedEvent})` : ''}${item.at ? `, logged at ${item.at}` : ''}: ${item.message}`,
        `- Expected: \`${JSON.stringify(item.expected)}\``,
        `- Model states before the line: ${item.frontier.map((state) => `\`${JSON.stringify(state)}\``).join(', ') || 'none'}`,
      );
      if (item.possible) lines.push(`- Model states the line could reach: ${item.possible.map((state) => `\`${JSON.stringify(state)}\``).join(', ') || 'none'}`);
      if (item.truncated) lines.push(`- Showing the first ${SHOWN_CANDIDATES} model states of each list.`);
      lines.push(
        '- Triage in order: the log call is in the wrong place or logs the wrong data; the model or rules file is wrong; the application is wrong.',
      );
    }
    if (trace.inconclusive) lines.push(`- Inconclusive${trace.inconclusive.line ? ` at trace line ${trace.inconclusive.line}` : ''}: ${trace.inconclusive.message}`);
    if (trace.inconclusive?.unresolvedGuards?.length) lines.push(`- Unresolved guards: ${trace.inconclusive.unresolvedGuards.join(', ')}`);
    if (trace.inconclusive?.unresolvedActions?.length) lines.push(`- Unresolved actions: ${trace.inconclusive.unresolvedActions.join(', ')}`);
    for (const warning of trace.warnings) lines.push(`- Warning, trace line ${warning.line}: ${warning.message}`);
    lines.push('');
  }
  return lines.join('\n');
}
