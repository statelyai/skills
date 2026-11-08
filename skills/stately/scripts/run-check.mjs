import { spawn } from 'node:child_process';
import {
  lstat,
  stat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rmdir,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, resolve, relative, sep } from 'node:path';
import { tmpdir, constants } from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { randomUUID } from 'node:crypto';
import { toolchainCache } from './toolchain.mjs';
import { artifact, parseCheckResult, sha256 } from './check-result.mjs';
import { attachReport, checkReport, projectedView } from './checked-view.mjs';
import { shareableDiagnostic } from './diagnostics.mjs';
import { completeHumanReport, parseCheckScope } from './check-scope.mjs';
import { readConfig } from './engine/frontends/config.ts';
import { readChecks } from './engine/frontends/spec.ts';
import { stateRules } from './engine/ir.ts';
import {
  killOwnedGroup,
  recoverOrRemoveStage,
  removeOwnedDirectory,
} from './process-control.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const text = async (file) =>
  new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(
    await readFile(file),
  );
const json = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + '\n');
const absent = (error) => error.code === 'ENOENT';
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
    throw Error(
      '--out must be a new or empty directory; existing artifacts are preserved.',
    );
  return target;
}
function configuredRules(config, module, strict = false) {
  try {
    const checks = readChecks({
      configFile: 'input.cfg',
      config: readConfig({ file: 'input.cfg', text: config }),
    });
    return [
      ...stateRules({ ...checks, module, variables: [] }),
      ...checks.properties.map((name) => ({ kind: 'property', name })),
    ].map((rule) => ({
      ...rule,
      id: `${rule.kind}:${rule.name}`,
      outcome: 'not-checked',
    }));
  } catch (error) {
    if (strict)
      throw Error(`Could not parse checker configuration: ${error.message}`);
    return [];
  }
}
async function stoppedResult(request, reason) {
  let preserved, preservedName, preservedContent;
  let existing = false;
  for (const name of ['check-result.json', 'check-result.raw.json']) {
    try {
      const content = await text(join(request.stage, name));
      existing = true;
      const result = parseCheckResult(JSON.parse(content));
      preserved = result;
      preservedName = name;
      preservedContent = content;
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') existing = true;
    }
  }
  const prefix = existing ? 'interrupted-' : '';
  const names = {
    result: preservedName ?? `${prefix}check-result.json`,
    report: `${prefix}report.md`,
    checkReport: `${prefix}check-report.json`,
    graph: `${prefix}graph.json`,
    run: `${prefix}run.json`,
  };
  const recheck = {
    ...(preserved?.recheck ?? request.recheck),
    resultPath: join(dirname(request.recheck.resultPath), names.result),
  };
  const result = preserved
    ? {
        ...preserved,
        recheck,
        kind: 'summary-only',
        states: [],
        transitions: [],
        counterexamples: [],
        projection: undefined,
      }
    : parseCheckResult({
        schemaVersion: 'stately.check-result.v1',
        kind: 'summary-only',
        binding: { artifacts: request.artifacts },
        checker: {
          name: 'TLC',
          version: request.toolchain?.version ?? 'unavailable',
          command: ['stately-check', 'check', request.recheck.specPath],
          complete: false,
          bounds: {
            timeoutSeconds: request.timeout,
            interrupted: true,
            chartStates: 500,
            rerunStates: 100000,
            ...(request.scope ? { domain: request.scope.bounds } : {}),
          },
          assumptions: [
            ...(request.scope?.assumptions ?? []),
            'The check did not finish; no rule is certified.',
          ],
        },
        states: [],
        transitions: [],
        rules: configuredRules(
          request.configText,
          basename(request.spec, '.tla'),
        ),
        counterexamples: [],
        recheck,
      });
  const content = JSON.stringify(result, null, 2) + '\n';
  if (!preserved)
    await writeFile(join(request.stage, names.result), content, { flag: 'wx' });
  const graph = projectedView(result, content);
  if (preserved)
    graph.data.meta['@statelyai.checkResultRef'] = {
      path: preservedName,
      sha256: sha256(preservedContent),
    };
  const detail = shareableDiagnostic(reason);
  const summary =
    (preserved
      ? `Recorded checker verdicts and ${preserved.counterexamples.length} raw failure paths are preserved in ${preservedName}; presentation/publication did not complete. This summary omits native path mappings. `
      : 'No completed checker result is certified. ') + detail.slice(0, 6000);
  const report = checkReport(result, graph, {
    status: preserved ? 'incomplete' : 'error',
    recheck: result.recheck ?? request.recheck,
    summary,
  });
  if (preserved)
    report.artifacts.push({
      role: 'result',
      path: preservedName,
      sha256: sha256(preservedContent),
    });
  let nativeView = true,
    nativeViewError;
  try {
    attachReport(graph, report);
    await json(join(request.stage, names.graph), graph);
  } catch (error) {
    nativeView = false;
    nativeViewError = shareableDiagnostic(error.message ?? String(error));
  }
  await Promise.all([
    json(join(request.stage, names.checkReport), report),
    writeFile(
      join(request.stage, names.report),
      shareableDiagnostic(
        completeHumanReport(`# Worker incomplete\n\n${summary}\n`, result),
      ),
      { flag: 'wx' },
    ),
  ]);
  return {
    report,
    names,
    nativeView,
    nativeViewError,
    preserved: preservedName,
  };
}

/** Executes one check in an isolated process group and publishes reviewable artifacts. */
export async function runCheck({
  spec: inputSpec,
  config: inputConfig,
  view: inputView,
  scope: inputScope,
  out,
  offline = false,
  timeout = 300,
  sources = [],
  shareDocuments = false,
}) {
  validateTimeout(timeout);
  if (!inputSpec?.endsWith('.tla'))
    throw Error('Pass a TLA+ .tla specification.');
  const originalSpec = resolve(inputSpec),
    originalConfig = resolve(
      inputConfig ?? inputSpec.replace(/\.tla$/, '.cfg'),
    );
  const originalView = inputView ? resolve(inputView) : undefined;
  const originalScope = inputScope ? resolve(inputScope) : undefined;
  const output = await emptyOutput(
    resolve(out ?? inputSpec.replace(/\.tla$/, '-chart')),
  );
  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(join(dirname(output), '.stately-check-stage-'));
  const temporary = await mkdtemp(
    join(await realpath(tmpdir()), 'stately-check-'),
  );
  const request = {
    stage,
    temporary,
    bootstrapDirectory: join(toolchainCache(), `java-stage-${randomUUID()}`),
    spec: join(stage, 'inputs', basename(originalSpec)),
    config: join(stage, 'inputs', 'Run.cfg'),
    view: originalView,
    artifacts: [],
    timeout,
    offline,
    shareDocuments,
    recheck: {
      specPath: originalSpec,
      configPath: originalConfig,
      ...(originalView ? { viewPath: originalView } : {}),
      ...(originalScope ? { scopePath: originalScope } : {}),
      workingDirectory: process.cwd(),
      sourcePaths: sources.map((file) => resolve(file)),
      sourceFiles: [],
      resultPath: join(output, 'check-result.json'),
    },
  };
  const bindInput = (role, path, sourceFile, content) => {
    request.artifacts.push(artifact(role, path, content));
    request.recheck.sourceFiles.push({
      path,
      sourcePath: relative(process.cwd(), resolve(sourceFile))
        .split(sep)
        .join('/'),
    });
  };
  let worker, janitor, interrupted, timer, lifecycleError;
  const runtime = process.versions.deno
    ? ['run', '--quiet', '--no-prompt', '--allow-all']
    : childRuntimeArgs(process.execArgv);
  const cleanupWarnings = new Set();
  const cleanupGroup = async () => {
    const cleanup = await killOwnedGroup(worker?.pid, temporary, stage, worker);
    if (cleanup.warning) {
      cleanupWarnings.add(cleanup.warning);
      // A direct live child remains addressable even when process inventory is unavailable.
      if (
        !cleanup.killed &&
        worker &&
        worker.exitCode === null &&
        worker.signalCode === null
      ) {
        // Until this direct child's exit is observed/reaped, its group ID cannot be reused.
        if (process.platform !== 'win32') {
          try {
            process.kill(-worker.pid, 'SIGKILL');
          } catch {
            worker.kill('SIGKILL');
          }
        } else worker.kill('SIGKILL');
      }
    }
  };
  const stop = (signal) => {
    interrupted = signal;
    if (worker?.pid) void cleanupGroup();
  };
  const onInt = () => stop('SIGINT'),
    onTerm = () => stop('SIGTERM');
  process.on('SIGINT', onInt);
  process.on('SIGTERM', onTerm);
  let run;
  try {
    janitor = spawn(
      process.execPath,
      [
        ...runtime,
        join(here, 'check-janitor.mjs'),
        '0',
        temporary,
        stage,
        output,
        request.bootstrapDirectory,
      ],
      {
        detached: true,
        windowsHide: true,
        stdio: ['pipe', 'ignore', 'ignore'],
      },
    );
    janitor.stdin.on('error', () => {});
    janitor.on('error', (error) => {
      lifecycleError = error;
      if (worker?.pid) void cleanupGroup();
    });
    await new Promise((settle, reject) => {
      janitor.once('spawn', settle);
      janitor.once('error', reject);
    });
    await mkdir(join(stage, 'inputs'));
    // Freeze local TLA modules and selected config; checking never mutates originals.
    for (const entry of await readdir(dirname(originalSpec), {
      withFileTypes: true,
    }))
      if (
        (entry.isFile() || entry.isSymbolicLink()) &&
        entry.name.endsWith('.tla')
      ) {
        const sourceFile = join(dirname(originalSpec), entry.name);
        if (!(await stat(sourceFile)).isFile())
          throw Error(`TLA input is not a regular file: ${entry.name}`);
        const content = await text(sourceFile);
        const path = `inputs/${entry.name}`;
        bindInput('spec', path, sourceFile, content);
        await writeFile(join(stage, path), content, { flag: 'wx' });
      }
    if (
      !request.artifacts.some(
        (item) => item.path === `inputs/${basename(originalSpec)}`,
      )
    )
      throw Error('Specification must be an existing regular .tla file.');
    request.configText = await text(originalConfig);
    bindInput('config', 'inputs/Run.cfg', originalConfig, request.configText);
    await writeFile(request.config, request.configText, { flag: 'wx' });
    if (originalView) {
      const content = await text(originalView);
      bindInput('view', 'inputs/projection-view.mjs', originalView, content);
      await writeFile(join(stage, 'inputs/projection-view.mjs'), content, {
        flag: 'wx',
      });
    }
    if (originalScope) {
      const content = await text(originalScope);
      request.scope = parseCheckScope(JSON.parse(content));
      const configured = new Set(
        configuredRules(
          request.configText,
          basename(originalSpec, '.tla'),
          true,
        ).map((rule) => rule.id),
      );
      for (const id of Object.keys(request.scope.ruleDescriptions ?? {}))
        if (!configured.has(id))
          throw Error(`Scope describes an unconfigured rule: ${id}`);
      bindInput('scope', 'inputs/check-scope.json', originalScope, content);
      await writeFile(join(stage, 'inputs/check-scope.json'), content, {
        flag: 'wx',
      });
    }
    for (const file of [...new Set(sources.map((file) => resolve(file)))])
      bindInput(
        'model',
        `source/${relative(process.cwd(), file).split(sep).join('/')}`,
        file,
        await text(file),
      );
    try {
      if (interrupted) throw Error(`${interrupted} stopped the check.`);
      const requestFile = join(temporary, 'request.json');
      await json(requestFile, request);
      worker = spawn(
        process.execPath,
        [...runtime, join(here, 'check-worker.mjs'), requestFile],
        {
          detached: true,
          windowsHide: true,
          stdio: ['pipe', 'ignore', 'pipe'],
          env: {
            ...process.env,
            TMPDIR: temporary,
            TEMP: temporary,
            TMP: temporary,
            STATELY_BOOTSTRAP_STAGE: request.bootstrapDirectory,
          },
        },
      );
      worker.stdin.on('error', () => {});
      let stderr = '';
      worker.stderr.on('data', (chunk) => {
        stderr = (stderr + chunk).slice(-16000);
      });
      const exited = new Promise((settle) => {
        worker.on('error', (error) =>
          settle({ code: 2, error: error.message }),
        );
        worker.on('exit', (code, signal) => settle({ code, signal }));
      });
      if (worker.pid) {
        janitor.stdin.write(`worker:${worker.pid}\n`);
        worker.stdin.write('ready\n');
      }
      if (timeout > 0)
        timer = setTimeout(() => stop('timeout'), timeout * 1000);
      const exit = await exited;
      clearTimeout(timer);
      if (worker.pid) await cleanupGroup();
      try {
        request.toolchain = JSON.parse(
          await text(join(stage, 'toolchain.json')),
        );
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      if (interrupted || lifecycleError || exit.code !== 0) {
        let detail;
        try {
          detail = await text(join(stage, 'worker-error.txt'));
        } catch {
          detail = lifecycleError?.message ?? exit.error ?? stderr;
        }
        throw Error(
          interrupted
            ? `${interrupted === 'timeout' ? `Time limit (${timeout}s)` : interrupted} stopped the worker. Recorded completed checker evidence, if any, is retained.`
            : `Checker failed: ${detail || exit.signal || exit.code}`,
        );
      }
      run = JSON.parse(await text(join(stage, 'run.json')));
      // Projection code executes once from its original module context; reject observed changes.
      if (
        originalView &&
        request.artifacts.find((item) => item.role === 'view').content !==
          (await text(originalView))
      )
        throw Error(
          'Projection source changed while checking. Recheck the current source.',
        );
    } catch (error) {
      const reason = interrupted
        ? `${interrupted === 'timeout' ? `Time limit (${timeout}s)` : interrupted} stopped the worker. Recorded completed checker evidence, if any, is retained.`
        : error.message;
      const stopped = await stoppedResult(request, reason);
      run = {
        status: stopped.report.status,
        nativeView: stopped.nativeView,
        ...(stopped.nativeViewError
          ? { nativeViewError: stopped.nativeViewError }
          : {}),
        artifactNames: stopped.names,
        ...(stopped.preserved
          ? { preservedCheckerResult: stopped.preserved }
          : {}),
        exit:
          interrupted === 'timeout'
            ? 124
            : interrupted
              ? 128 + (constants.signals[interrupted] ?? 0)
              : 2,
      };
      await json(join(stage, stopped.names.run), run);
    }
    if (cleanupWarnings.size) {
      run.cleanupWarnings = [...cleanupWarnings];
      await json(join(stage, run.artifactNames?.run ?? 'run.json'), run);
    }
    await emptyOutput(output);
    try {
      await rename(stage, output);
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EEXIST', 'EPERM'].includes(error.code)
      )
        throw error;
      await emptyOutput(output);
      await rmdir(output);
      await rename(stage, output);
    }
    return {
      ...run,
      output,
      ...(run.compactReport
        ? { compactReport: join(output, run.compactReport) }
        : {}),
      report: join(output, run.artifactNames?.report ?? 'report.md'),
      result: join(output, run.artifactNames?.result ?? 'check-result.json'),
      checkReport: join(
        output,
        run.artifactNames?.checkReport ?? 'check-report.json',
      ),
      ...(run.nativeView
        ? { graph: join(output, run.artifactNames?.graph ?? 'graph.json') }
        : {}),
    };
  } finally {
    clearTimeout(timer);
    process.off('SIGINT', onInt);
    process.off('SIGTERM', onTerm);
    if (worker?.pid) await cleanupGroup();
    try {
      await removeOwnedDirectory(temporary);
      await removeOwnedDirectory(request.bootstrapDirectory);
      const recovered = await recoverOrRemoveStage(stage, output);
      if (recovered)
        console.error(`Completed checker artifacts recovered at ${recovered}`);
      janitor?.stdin.end('done\n');
    } finally {
      janitor?.stdin.end();
      janitor?.unref();
    }
  }
}

export function childRuntimeArgs(args) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (['-e', '--eval', '-p', '--print', '--input-type'].includes(flag)) {
      i++;
      continue;
    }
    if (
      /^--(?:input-type=|eval=|print=|test(?:$|-)|inspect(?:$|-|=))/.test(flag)
    ) {
      if (
        !flag.includes('=') &&
        flag.startsWith('--test-') &&
        args[i + 1] &&
        !args[i + 1].startsWith('-')
      )
        i++;
      continue;
    }
    result.push(flag);
  }
  return result;
}

function validateTimeout(value) {
  if (!Number.isFinite(value) || value < 0 || value * 1000 > 2147483647)
    throw Error(
      '--timeout must be 0 (disabled) or nonnegative seconds up to 2147483.647.',
    );
}

export function parseCheckArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      config: { type: 'string' },
      view: { type: 'string' },
      out: { type: 'string' },
      timeout: { type: 'string' },
      scope: { type: 'string' },
      source: { type: 'string', multiple: true },
      offline: { type: 'boolean' },
      json: { type: 'boolean' },
      compact: { type: 'boolean' },
      'share-documents': { type: 'boolean' },
    },
  });
  if (positionals.length !== 1)
    throw Error('Pass exactly one .tla specification.');
  const { source = [], 'share-documents': shareDocuments, ...flags } = values;
  const options = {
    ...flags,
    spec: positionals[0],
    sources: source,
    ...(shareDocuments === undefined ? {} : { shareDocuments }),
  };
  if (options.timeout !== undefined) {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)$/.test(options.timeout))
      throw Error(
        '--timeout must explicitly give nonnegative decimal seconds; 0 disables the limit.',
      );
    options.timeout = Number(options.timeout);
    validateTimeout(options.timeout);
  }
  return options;
}
