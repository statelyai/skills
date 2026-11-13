// `stately-check check MODEL.json --rules RULES.json`: the native explicit-state checker
// with the same artifact layout and recheck binding as the TLC path in run-check.mjs.
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';
import { artifact, parseCheckResult } from './check-result.mjs';
import { attachReport } from './checked-view.mjs';
import { completeHumanReport, parseCheckScope } from './check-scope.mjs';
import { CHECKER_NAME, CHECKER_VERSION, check, checkReport, humanReport, loadCachedXState, nativeCheckExitCode, nativeGraph } from './native-check.mjs';

const text = async (file) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const absent = (error) => error.code === 'ENOENT';
const posix = (file) => relative(process.cwd(), file).split(sep).join('/');

async function emptyOutput(output) {
  let info;
  try {
    info = await lstat(output);
  } catch (error) {
    if (absent(error)) return output;
    throw error;
  }
  const target = info.isSymbolicLink() ? await realpath(output) : output;
  if (!(await lstat(target)).isDirectory() || (await readdir(target)).length)
    throw Object.assign(
      Error(`--out ${output} already exists and is not an empty directory. Choose a new --out; existing artifacts are preserved.`),
      { code: 'EEXIST', path: output },
    );
  return target;
}
async function isFile(path) {
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (absent(error)) return false;
    throw error;
  }
}
async function requireFile(path, what, hint = '') {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (!absent(error)) throw error;
    throw Object.assign(Error(`${what} not found: ${path}.${hint}`), { code: 'ENOENT', path });
  }
  if (!info.isFile())
    throw Object.assign(Error(`${what} is not a regular file: ${path}.`), { code: 'EISDIR', path });
}

function compactReport(result) {
  const states = new Map(result.states.map((state) => [state.id, state]));
  const steps = new Map(result.transitions.map((step) => [step.id, step]));
  const lines = [`# ${CHECKER_NAME}: ${result.rules.filter((rule) => rule.outcome === 'broken').length} broken`, ''];
  for (const rule of result.rules) {
    lines.push(`- ${rule.id}: ${rule.outcome}`);
    for (const trace of result.counterexamples.filter((item) => item.ruleId === rule.id)) {
      const path = trace.states.map((id, index) => {
        const nodes = states.get(id).nodeIds.join('+');
        return index ? `${steps.get(trace.transitions[index - 1]).action} -> ${nodes}` : nodes;
      });
      lines.push(`  ${trace.id}: ${path.join(' | ')}${trace.loopStart !== undefined ? ` (loops to step ${trace.loopStart})` : ''}${trace.stutters ? ' (stutters)' : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

export async function runNativeCheck({ model, rules, scope, out, offline = false, sources = [], shareDocuments = false }) {
  if (!model?.endsWith('.json')) throw Error('Pass a native model .json file (or a .tla specification for TLC).');
  const modelPath = resolve(model);
  await requireFile(modelPath, 'Model');
  const defaultRules = modelPath.replace(/\.json$/, '.rules.json');
  if (!rules && !(await isFile(defaultRules)))
    throw Object.assign(
      Error(`Rules file not found: ${defaultRules}. Pass --rules RULES.json; the default is <model>.rules.json beside the model.`),
      { code: 'ENOENT', path: defaultRules },
    );
  const rulesPath = resolve(rules ?? defaultRules);
  await requireFile(rulesPath, 'Rules');
  const scopePath = scope ? resolve(scope) : undefined;
  if (scopePath) await requireFile(scopePath, 'Scope');
  for (const file of sources) await requireFile(resolve(file), 'Source');
  const output = await emptyOutput(resolve(out ?? modelPath.replace(/\.json$/, '-check')));

  const modelContent = await text(modelPath);
  const rulesContent = await text(rulesPath);
  const scopeContent = scopePath ? await text(scopePath) : undefined;
  const parsedScope = scopeContent === undefined ? undefined : parseCheckScope(JSON.parse(scopeContent));
  const run = check({
    model: JSON.parse(modelContent),
    rules: JSON.parse(rulesContent),
    modelContent,
    rulesContent,
    modelPath: 'inputs/model.json',
    rulesPath: 'inputs/rules.json',
    xstate: await loadCachedXState({ offline }),
  });
  const result = run.result;
  const recheck = {
    specPath: modelPath,
    configPath: rulesPath,
    modelPath,
    rulesPath,
    ...(scopePath ? { scopePath } : {}),
    workingDirectory: process.cwd(),
    sourcePaths: sources.map((file) => resolve(file)),
    sourceFiles: [
      { path: 'inputs/model.json', sourcePath: posix(modelPath) },
      { path: 'inputs/rules.json', sourcePath: posix(rulesPath) },
    ],
    resultPath: join(output, 'check-result.json'),
  };
  const bind = (role, path, file, content) => {
    result.binding.artifacts.push(artifact(role, path, content));
    recheck.sourceFiles.push({ path, sourcePath: posix(file) });
  };
  if (parsedScope) {
    const ids = new Set(result.rules.map((rule) => rule.id));
    for (const id of Object.keys(parsedScope.ruleDescriptions ?? {}))
      if (!ids.has(id)) throw Error(`Scope describes an unconfigured rule: ${id}`);
    for (const rule of result.rules)
      if (parsedScope.ruleDescriptions?.[rule.id]) rule.description = parsedScope.ruleDescriptions[rule.id];
    result.checker.bounds.domain = parsedScope.bounds;
    result.checker.assumptions = [...result.checker.assumptions, ...parsedScope.assumptions];
    bind('scope', 'inputs/check-scope.json', scopePath, scopeContent);
  }
  for (const file of [...new Set(sources.map((file) => resolve(file)))])
    bind('model', `source/${posix(file)}`, file, await text(file));
  result.recheck = recheck;
  const checked = parseCheckResult(JSON.parse(JSON.stringify(result)));

  const report = completeHumanReport(humanReport(run), checked);
  let graph, nativeViewError;
  try {
    graph = nativeGraph(run, JSON.parse(modelContent));
    const attached = graph.data.meta['@statelyai.checkReport'];
    attached.recheck = recheck;
    // The rules and scope files hold no application source, so they always travel with
    // the saved result: an editor Recheck needs them. --share-documents adds the model
    // file and the human report.
    attached.documents = [
      { path: 'inputs/rules.json', language: 'json', content: rulesContent },
      ...(scopeContent === undefined ? [] : [{ path: 'inputs/check-scope.json', language: 'json', content: scopeContent }]),
      ...(shareDocuments
        ? [
            { path: 'inputs/model.json', language: 'json', content: modelContent },
            { path: 'report.md', language: 'markdown', content: report },
          ]
        : []),
    ];
    for (const item of attached.artifacts)
      if (attached.documents.some((document) => document.path === item.path)) item.documentPath = item.path;
    delete graph.data.meta['@statelyai.checkViewSha256'];
    attachReport(graph, attached);
  } catch (error) {
    graph = undefined;
    nativeViewError = error.message;
  }

  const status = checked.rules.some((rule) => rule.outcome === 'not-checked') || !checked.checker.complete ? 'incomplete' : 'complete';
  const exit = nativeCheckExitCode(checked);
  await mkdir(join(output, 'inputs'), { recursive: true });
  await writeFile(join(output, 'inputs/model.json'), await readFile(modelPath), { flag: 'wx' });
  await writeFile(join(output, 'inputs/rules.json'), await readFile(rulesPath), { flag: 'wx' });
  if (scopePath) await writeFile(join(output, 'inputs/check-scope.json'), await readFile(scopePath), { flag: 'wx' });
  await writeJson(join(output, 'check-result.json'), checked);
  await writeFile(join(output, 'report.md'), report, { flag: 'wx' });
  await writeFile(join(output, 'compact-report.md'), compactReport(checked), { flag: 'wx' });
  const checkReportValue = graph
    ? graph.data.meta['@statelyai.checkReport']
    : {
        ...checkReport(run, {
          summary:
            'The native view exceeded the saved-view budget; verdicts and counterexamples are in check-result.json and report.md. No trace is attached.',
        }),
        recheck,
      };
  await writeJson(join(output, 'check-report.json'), checkReportValue);
  if (graph) await writeJson(join(output, 'graph.json'), graph);
  const paths = {
    output,
    report: join(output, 'report.md'),
    compactReport: join(output, 'compact-report.md'),
    result: join(output, 'check-result.json'),
    checkReport: join(output, 'check-report.json'),
    ...(graph ? { graph: join(output, 'graph.json') } : {}),
  };
  const summary = {
    checker: CHECKER_NAME,
    version: CHECKER_VERSION,
    exit,
    status,
    nativeView: Boolean(graph),
    ...(nativeViewError ? { nativeViewError } : {}),
    elapsedMs: Math.round(run.elapsedMs ?? checked.checker.bounds.elapsedMs ?? 0),
    ...paths,
  };
  await writeJson(join(output, 'run.json'), summary);
  return summary;
}

export function parseNativeCheckArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      rules: { type: 'string' },
      scope: { type: 'string' },
      out: { type: 'string' },
      source: { type: 'string', multiple: true },
      offline: { type: 'boolean' },
      json: { type: 'boolean' },
      compact: { type: 'boolean' },
      'share-documents': { type: 'boolean' },
    },
  });
  if (positionals.length !== 1) throw Error('Pass exactly one model .json file.');
  const { source = [], 'share-documents': shareDocuments, ...flags } = values;
  return { ...flags, model: positionals[0], sources: source, shareDocuments: shareDocuments === true };
}
