#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { artifact, parseCheckResult, resultToXGraph } from './check-result.mjs';
import { importTlcTrace, importTlcDot } from './tlc-import.mjs';
import { exportNativeTla, moduleName } from './native-tla.mjs';

const readText = async (path) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    await readFile(path),
  );
const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const usage = `Usage:
  stately-check.mjs check MODEL.json --rules RULES.json [--scope FILE] [--out DIR] [--source FILE] [--offline] [--share-documents] [--compact] [--json]
  stately-check.mjs check SPEC.tla [--config FILE] [--view FILE] [--out DIR] [--source FILE] [--scope FILE] [--manifest FILE] [--timeout SECONDS] [--offline] [--share-documents] [--compact] [--json] (TLA+, opt-in)
  stately-check.mjs render CHART.mmd [--out FILE.svg] [--offline]
  stately-check.mjs import-trace TRACE SPEC CONFIG PROVENANCE_JSON RESULT_JSON
  stately-check.mjs import-dot DOT SPEC CONFIG PROVENANCE_JSON RESULT_JSON
  stately-check.mjs graph RESULT_JSON XGRAPH_JSON
  stately-check.mjs freshness RESULT_JSON [--workspace DIRECTORY]
  stately-check.mjs record-app-checks GRAPH_JSON CHECKS_JSON NEW_GRAPH_JSON
  stately-check.mjs view RESULT_JSON [--trace ID ...] --out XGRAPH_JSON
  stately-check.mjs export MODEL_JSON RULES_JSON NEW_OUTPUT_DIR [--module NAME]
Output paths must not already exist. See references/formal-checking.md.`;
const usageError = () => Object.assign(Error(usage), { code: 'USAGE' });
const messages = {
  ENOENT: (path) => `Not found: ${path}. Check the path and retry.`,
  EEXIST: (path) =>
    `Already exists: ${path}. Choose a new output path; existing files are preserved.`,
  EISDIR: (path) => `Expected a file but found a directory: ${path}.`,
  ENOTDIR: (path) => `A parent of ${path} is not a directory.`,
  EACCES: (path) => `Permission denied: ${path}.`,
  EPERM: (path) => `Permission denied: ${path}.`,
};
/** One actionable line (or the usage text) instead of a raw Node error. */
export function describeError(error) {
  const code =
    error?.code ?? (error instanceof SyntaxError ? 'EJSON' : 'ERROR');
  const message =
    error?.syscall && error.path && messages[code]
      ? messages[code](error.path)
      : code === 'EJSON'
        ? `Invalid JSON input: ${error.message}`
        : (error?.message ?? String(error));
  return { code, message, ...(error?.path ? { path: error.path } : {}) };
}

const isCheckCommand = (command) =>
  command === 'check' ||
  command?.endsWith('.tla') ||
  command?.endsWith('.json') ||
  command?.startsWith('-');
const isNativeCheck = (args) =>
  args.includes('--rules') ||
  args.some((arg) => arg.startsWith('--rules=')) ||
  args.find((arg) => !arg.startsWith('-'))?.endsWith('.json');

export async function main(args) {
  const [command, ...paths] =
    isCheckCommand(args[0]) && args[0] !== 'check' ? ['check', ...args] : args;
  if (command === 'check') {
    const native = isNativeCheck(paths);
    const { runCheck, parseCheckArgs } = native
      ? await import('./run-native-check.mjs').then((module) => ({
          runCheck: module.runNativeCheck,
          parseCheckArgs: module.parseNativeCheckArgs,
        }))
      : await import('./run-check.mjs');
    const options = parseCheckArgs(paths);
    const run = await runCheck(options);
    console.log(
      options.json
        ? JSON.stringify(run, null, 2)
        : `${await readText(options.compact && run.compactReport ? run.compactReport : run.report)}\nArtifacts: ${run.output}\nFull scope report: ${run.report}${run.graph ? `\nNative view: ${run.graph}` : `\nNative view unavailable: ${run.nativeViewError}`}`,
    );
    return run;
  }
  if (command === 'render') {
    const { values, positionals } = parseArgs({
      args: paths,
      allowPositionals: true,
      options: { out: { type: 'string' }, offline: { type: 'boolean' } },
    });
    if (positionals.length !== 1) throw usageError();
    const { renderChart } = await import('./render-chart.mjs');
    console.log(
      JSON.stringify(
        await renderChart({ input: positionals[0], ...values }),
        null,
        2,
      ),
    );
    return;
  }
  if (['import-trace', 'import-dot'].includes(command) && paths.length === 5) {
    const [inputPath, specPath, configPath, provenancePath, outputPath] = paths;
    const [content, spec, config, provenance] = await Promise.all(
      [inputPath, specPath, configPath, provenancePath].map(readText),
    );
    const role = command === 'import-trace' ? 'trace' : 'dot';
    const imported = (
      command === 'import-trace' ? importTlcTrace : importTlcDot
    )({
      content,
      artifacts: [
        artifact(role, basename(inputPath), content),
        artifact('spec', basename(specPath), spec),
        artifact('config', basename(configPath), config),
      ],
      provenance: JSON.parse(provenance),
    });
    await writeJson(outputPath, imported);
    return;
  }
  if (command === 'freshness') {
    const [input, ...flags] = paths;
    if (
      !input ||
      (flags.length && (flags.length !== 2 || flags[0] !== '--workspace'))
    )
      throw usageError();
    const { currentSourceHashes } = await import('./check-evidence.mjs');
    console.log(
      JSON.stringify(
        await currentSourceHashes(JSON.parse(await readText(input)), flags[1]),
        null,
        2,
      ),
    );
    return;
  }
  if (command === 'record-app-checks' && paths.length === 3) {
    const { withApplicationChecks } = await import('./check-evidence.mjs');
    await writeJson(
      paths[2],
      withApplicationChecks(
        JSON.parse(await readText(paths[0])),
        JSON.parse(await readText(paths[1])),
      ),
    );
    return;
  }
  if (command === 'view') {
    const [input, ...flags] = paths;
    const traceIds = [];
    let output;
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === '--trace' && flags[i + 1]) traceIds.push(flags[++i]);
      else if (flags[i] === '--out' && flags[i + 1] && !output)
        output = flags[++i];
      else throw usageError();
    }
    if (!input || !output) throw usageError();
    const content = await readText(input);
    const { selectCheckView } = await import('./select-view.mjs');
    await writeJson(
      output,
      selectCheckView(JSON.parse(content), {
        content,
        resultPath: input,
        traceIds,
      }),
    );
    return;
  }
  if (command === 'graph' && paths.length === 2) {
    const content = await readText(paths[0]);
    const result = parseCheckResult(JSON.parse(content));
    const { projectedView, checkReport, attachReport } =
      await import('./checked-view.mjs');
    const graph = projectedView(result, content);
    graph.data.meta['@statelyai.checkResultRef'] = {
      path: basename(paths[0]),
      sha256: (await import('./check-result.mjs')).sha256(content),
    };
    const recheck = result.recheck
      ? { ...result.recheck, resultPath: resolve(paths[0]) }
      : undefined;
    await writeJson(
      paths[1],
      attachReport(graph, checkReport(result, graph, { recheck })),
    );
    return;
  }
  if (command === 'export') {
    const { values, positionals } = parseArgs({
      args: paths,
      allowPositionals: true,
      options: { module: { type: 'string' } },
    });
    if (positionals.length !== 3) throw usageError();
    const [modelPath, rulesPath, output] = positionals;
    const module =
      values.module ??
      moduleName(basename(modelPath).replace(/\.json$/, ''));
    const result = exportNativeTla({
      model: JSON.parse(await readText(modelPath)),
      rules: JSON.parse(await readText(rulesPath)),
      module,
    });
    await mkdir(output);
    await writeFile(join(output, `${module}.tla`), result.spec, { flag: 'wx' });
    await writeFile(join(output, `${module}.cfg`), result.config, {
      flag: 'wx',
    });
    await writeJson(join(output, 'manifest.json'), result.manifest);
    console.log(
      JSON.stringify({ module, out: output, rules: result.manifest.rules.length }),
    );
    return;
  }
  throw usageError();
}
if (process.env.STATELY_LAUNCHER_DEBUG === '1')
  console.error(
    JSON.stringify({
      entrypoint: import.meta.url,
      nativeMain: import.meta.main,
      argv: process.argv,
    }),
  );
const isMain =
  import.meta.main ??
  (process.argv[1] &&
    realpathSync.native(fileURLToPath(import.meta.url)) ===
      realpathSync.native(process.argv[1]));
if (isMain) {
  try {
    const run = await main(process.argv.slice(2));
    if (run?.exit !== undefined) process.exitCode = run.exit;
  } catch (error) {
    const described = describeError(error);
    const flags = process.argv.slice(2);
    const end = flags.indexOf('--');
    const json = (end < 0 ? flags : flags.slice(0, end)).includes('--json');
    if (json)
      console.log(JSON.stringify({ ok: false, error: described }, null, 2));
    else console.error(described.message);
    process.exitCode = isCheckCommand(process.argv[2]) ? 2 : 1;
  }
}
