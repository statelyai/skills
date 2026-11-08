#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { artifact, parseCheckResult, resultToXGraph } from './check-result.mjs';
import { importTlcTrace, importTlcDot } from './tlc-import.mjs';
import { exportNativeTla } from './native-tla.mjs';

const readText = async (path) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    await readFile(path),
  );
const writeJson = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx' });
const usage = `Usage:
  stately-check.mjs check SPEC.tla [--config FILE] [--view FILE] [--out DIR] [--source FILE] [--scope FILE] [--timeout SECONDS] [--offline] [--share-documents] [--compact] [--json]
  stately-check.mjs render CHART.mmd [--out FILE.svg] [--offline]
  stately-check.mjs import-trace TRACE SPEC CONFIG PROVENANCE_JSON RESULT_JSON
  stately-check.mjs import-dot DOT SPEC CONFIG PROVENANCE_JSON RESULT_JSON
  stately-check.mjs graph RESULT_JSON XGRAPH_JSON
  stately-check.mjs freshness RESULT_JSON [--workspace DIRECTORY]
  stately-check.mjs record-app-checks GRAPH_JSON CHECKS_JSON NEW_GRAPH_JSON
  stately-check.mjs view RESULT_JSON [--trace ID ...] --out XGRAPH_JSON
  stately-check.mjs export MODEL_XGRAPH_JSON OPTIONS_JSON NEW_OUTPUT_DIR
Output paths must not already exist. See references/formal-checking.md.`;

const isCheckCommand = (command) =>
  command === 'check' || command?.endsWith('.tla') || command?.startsWith('-');

export async function main(args) {
  const [command, ...paths] =
    isCheckCommand(args[0]) && args[0] !== 'check' ? ['check', ...args] : args;
  if (command === 'check') {
    const { runCheck, parseCheckArgs } = await import('./run-check.mjs');
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
    if (positionals.length !== 1) throw Error(usage);
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
      throw Error(usage);
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
      else throw Error(usage);
    }
    if (!input || !output) throw Error(usage);
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
  if (command === 'export' && paths.length === 3) {
    const [modelPath, optionsPath, output] = paths;
    const content = await readText(modelPath);
    const options = JSON.parse(await readText(optionsPath));
    if (
      Object.keys(options).some(
        (key) => !['module', 'bounds', 'invariants'].includes(key),
      )
    )
      throw Error('Unknown exporter option.');
    const module = options.module ?? 'StatelyModel';
    const result = exportNativeTla({
      content,
      path: basename(modelPath),
      ...options,
      module,
    });
    await mkdir(output);
    await writeFile(join(output, `${module}.tla`), result.spec, { flag: 'wx' });
    await writeFile(join(output, `${module}.cfg`), result.config, {
      flag: 'wx',
    });
    await writeJson(join(output, 'manifest.json'), result.manifest);
    return;
  }
  throw Error(usage);
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
    console.error(error.message);
    process.exitCode = isCheckCommand(process.argv[2]) ? 2 : 1;
  }
}
