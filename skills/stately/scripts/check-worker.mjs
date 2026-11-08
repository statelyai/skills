import { readFile, writeFile } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspect } from 'node:util';
import { check, PINNED_FLAGS } from './engine/run.ts';
import { checkView } from './engine/frontends/view.ts';
import { walk, bugs } from './engine/passes/reach.ts';
import { project } from './engine/pipeline.ts';
import { report as renderReport } from './engine/backends/report.ts';
import { mermaidLines } from './engine/backends/mermaid.ts';
import { plainText } from './engine/backends/plain-text.ts';
import { exportEngineResult } from './engine-result.mjs';
import { sha256, entityId } from './check-result.mjs';
import { completeHumanReport } from './check-scope.mjs';
import { shareableDiagnostic } from './diagnostics.mjs';
import { attachReport, checkReport, projectedView } from './checked-view.mjs';
import { ensureToolchain, PROGRESS_PREFIX } from './toolchain.mjs';

await new Promise((resolve) => {
  process.stdin.once('data', resolve);
  process.stdin.once('end', () => process.exit(2));
  process.stdin.resume();
});
process.stdin.destroy();
const request = JSON.parse(await readFile(process.argv[2], 'utf8'));
const { stage, spec, config, view: viewPath, shareDocuments } = request;
const json = (name, value) =>
  writeFile(join(stage, name), JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
  });
try {
  process.env.TMPDIR = request.temporary;
  process.env.TEMP = request.temporary;
  process.env.TMP = request.temporary;
  const toolchain = await ensureToolchain({
    offline: request.offline,
    installDirectory: request.bootstrapDirectory,
    progress: (line) => process.stderr.write(`${PROGRESS_PREFIX}${line}\n`),
  });
  await json('toolchain.json', toolchain);
  const engine = JSON.parse(
    await readFile(new URL('./engine/upstream.json', import.meta.url), 'utf8'),
  );
  const view = checkView(
    viewPath
      ? await import(pathToFileURL(viewPath).href)
      : {
          title: basename(spec, '.tla'),
        },
    inspect,
  );
  process.env.JAVA = toolchain.java;
  process.env.TLA2TOOLS = toolchain.jar;
  const checked = await check(spec, config);
  const walked = walk(checked.graph);
  const found = [...(checked.paths ?? bugs(checked.graph, walked))].sort(
    (a, b) => a.path.length - b.path.length,
  );
  for (const property of checked.properties)
    if (property.bug) found.push({ rule: property.rule, ...property.bug });
  const modules = checked.spec.sourceModules;
  const artifacts = request.artifacts.filter(
    (item) =>
      item.role !== 'spec' ||
      !modules?.length ||
      modules.includes(basename(item.path, '.tla')),
  );
  const paths = new Set(artifacts.map((item) => item.path));
  const recheck = {
    ...request.recheck,
    sourceFiles: request.recheck.sourceFiles.filter((file) =>
      paths.has(file.path),
    ),
  };
  const checker = {
    name: 'TLC',
    version: toolchain.version,
    checkedAt: new Date().toISOString(),
    command: [
      toolchain.java,
      '-cp',
      toolchain.jar,
      'tlc2.TLC',
      ...PINNED_FLAGS,
      spec,
    ],
    bounds: {
      configuration: artifacts.find((item) => item.role === 'config')?.path,
      configuredSections: checked.spec.written,
      ...(request.scope ? { domain: request.scope.bounds } : {}),
      explored: checked.states,
      timeoutSeconds: request.timeout,
      rerunStates: 100000,
      chartStates: 500,
      graphScope: checked.paths
        ? 'counterexamples-only'
        : 'bounded-configurations',
      moduleSnapshot: modules?.length
        ? 'SANY loaded local module closure'
        : 'local EXTENDS/INSTANCE closure snapshot',
      tlcSha256: toolchain.sha256,
      javaVersion: toolchain.javaVersion,
      javaOptionsConfigured: [
        'JAVA_TOOL_OPTIONS',
        'JDK_JAVA_OPTIONS',
        '_JAVA_OPTIONS',
      ].filter((name) => process.env[name]),
      engineSource: `${engine.source}@${engine.commit} (${engine.version}; MIT; base ${engine.officialSource}@${engine.officialCommit}; native label/module provenance adaptations)`,
    },
    assumptions: [
      ...(request.scope?.assumptions ?? [
        'No model-specific assumption list was supplied; inspect the specification and use --scope to record reviewed domain assumptions.',
      ]),
      'Results apply to this finite configured TLA+ model, its constraints and fairness; they do not prove the application refines the model.',
      'View functions are trusted projection code. External JavaScript dependencies and environmental effects are not proven by file digests.',
      'Diagram events are synthetic view navigation. Checks replays raw checker failures; separate application replay is still required.',
    ],
  };
  const normalize = (projected = {}) => {
    const result = exportEngineResult({
      result: checked,
      walked,
      ...projected,
      found,
      artifacts,
      checker,
    });
    for (const rule of result.rules)
      if (request.scope?.ruleDescriptions?.[rule.id])
        rule.description = request.scope.ruleDescriptions[rule.id];
    for (const verdict of checked.properties)
      if (verdict.initialOnly) {
        const rule = result.rules.find(
          (rule) => rule.id === `property:${verdict.rule.name}`,
        );
        if (rule)
          rule.description = [
            rule.description,
            'State-level PROPERTY: TLC checks this predicate only in initial states; use INVARIANT or a temporal formula to require it throughout every behavior.',
          ]
            .filter(Boolean)
            .join(' ');
      }
    result.recheck = recheck;
    return result;
  };
  const raw = normalize();
  checker.runId = entityId(
    'run',
    JSON.stringify([
      raw.binding.artifacts.map(({ role, path, sha256 }) => ({
        role,
        path,
        sha256,
      })),
      raw.checker,
      raw.rules,
    ]),
  );
  raw.checker.runId = checker.runId;
  // Durable checker checkpoint precedes arbitrary presentation callbacks.
  await json('check-result.raw.json', raw);
  const rawText = completeHumanReport(
    [
      '# Raw checker evidence',
      '',
      ...raw.rules.map((rule) => `${rule.id}: ${rule.outcome}`),
      '',
      ...raw.counterexamples.flatMap((trace) => [
        `Counterexample ${trace.id} (${trace.ruleId}): ${trace.transitions.length} steps; raw states ${trace.states.join(' → ')}.`,
        ...(trace.loopStart !== undefined
          ? [
              `Loop starts at ${trace.loopStart}; stuttering: ${trace.stutters === true}.`,
            ]
          : []),
      ]),
      'Full variables and transitions are in check-result.raw.json.',
    ].join('\n'),
    raw,
  );
  await writeFile(
    join(stage, 'raw-report.md'),
    shareableDiagnostic(rawText) + '\n',
    { flag: 'wx' },
  );
  await writeFile(
    join(stage, 'tlc.out'),
    [...plainText(checked.messages)].join(''),
    { flag: 'wx' },
  );
  const outputRecords = [],
    aliases = new Map();
  for (const verdict of [...checked.rules, ...checked.properties])
    if (verdict.outcome === 'broken' && verdict.messages) {
      const { rule } = verdict,
        id = `${rule.kind}:${rule.name}`;
      const file = `tlc-${rule.kind}-${rule.name.slice(0, 80)}-${entityId('rule', id)}.out`;
      const content = [...plainText(verdict.messages)].join('');
      await writeFile(join(stage, file), content, { flag: 'wx' });
      outputRecords.push({
        role: 'output',
        path: file,
        sha256: sha256(content),
      });
      const key = rule.name.toLowerCase();
      if (!aliases.has(key)) aliases.set(key, { name: rule.name, parts: [] });
      aliases.get(key).parts.push({ rule, content, file });
    }
  const aliasNames = new Map();
  for (const alias of aliases.values()) {
    const name =
      alias.name.length <= 180
        ? alias.name
        : `${alias.name.slice(0, 80)}-${entityId('name', alias.name)}`;
    const file = `tlc-${name}.out`;
    const content =
      alias.parts.length === 1
        ? alias.parts[0].content
        : alias.parts
            .map(
              (part) =>
                `=== ${part.rule.kind} ${part.rule.name} (${part.file}) ===\n${part.content}`,
            )
            .join('\n');
    await writeFile(join(stage, file), content, { flag: 'wx' });
    for (const part of alias.parts) aliasNames.set(part.rule.name, file);
    outputRecords.push({ role: 'output', path: file, sha256: sha256(content) });
  }
  const projected =
    found.length || !checked.paths
      ? project(checked.graph, walked, view, found)
      : { chart: undefined, labels: undefined, stories: new Map() };
  const result = normalize(projected);
  let human = renderReport(checked, found, projected.chart, projected.stories);
  for (const [name, file] of aliasNames)
    human = human.replaceAll(`in tlc-${name}.out.`, `in ${file}.`);
  await writeFile(
    join(stage, 'compact-report.md'),
    shareableDiagnostic(human) + '\n',
    { flag: 'wx' },
  );
  const text = shareableDiagnostic(completeHumanReport(human, result));
  await writeFile(join(stage, 'report.md'), text + '\n', { flag: 'wx' });
  if (projected.chart)
    await writeFile(
      join(stage, 'chart.mmd'),
      [...mermaidLines(projected.chart)].join('\n') + '\n',
      { flag: 'wx' },
    );
  await json('check-result.json', result);
  const resultContent = await readFile(
    join(stage, 'check-result.json'),
    'utf8',
  );
  const documents = shareDocuments
    ? [
        ...artifacts
          .filter(
            (item) =>
              item.path === `inputs/${basename(spec)}` ||
              ['config', 'view', 'scope'].includes(item.role),
          )
          .map((item) => ({
            path: item.path,
            language:
              item.role === 'spec'
                ? 'tla'
                : item.role === 'scope'
                  ? 'json'
                  : 'text',
            content: item.content,
          })),
        { path: 'report.md', language: 'markdown', content: text + '\n' },
      ]
    : [];
  try {
    const graph = projectedView(result, resultContent);
    const summary = [
      `${result.rules.filter((rule) => rule.outcome === 'broken').length} broken; ${result.rules.filter((rule) => rule.outcome === 'holds').length} hold; ${result.rules.filter((rule) => rule.outcome === 'not-checked').length} not checked.`,
      ...(result.projection?.notes ?? []),
      ...(result.kind === 'summary-only'
        ? [
            'No configurations chart was generated; full checker verdicts and artifacts remain available.',
          ]
        : []),
      'Source freshness must be compared in the coding workspace. Application evidence is recorded separately below.',
    ].join('\n');
    const report = checkReport(result, graph, { documents, recheck, summary });
    const shared = new Set(documents.map((document) => document.path));
    for (const item of report.artifacts)
      if (shared.has(item.path)) item.documentPath = item.path;
    report.artifacts.push(
      {
        role: 'report',
        path: 'report.md',
        sha256: sha256(text + '\n'),
        ...(shared.has('report.md') ? { documentPath: 'report.md' } : {}),
      },
      {
        role: 'report',
        path: 'compact-report.md',
        sha256: sha256(shareableDiagnostic(human) + '\n'),
      },
      {
        role: 'result',
        path: 'check-result.json',
        sha256: sha256(resultContent),
      },
      {
        role: 'output',
        path: 'tlc.out',
        sha256: sha256(await readFile(join(stage, 'tlc.out'))),
      },
      ...outputRecords,
    );
    attachReport(graph, report);
    await json('check-report.json', report);
    await json('graph.json', graph);
    await json('run.json', {
      exit: checked.exit,
      status: report.status,
      nativeView: true,
      compactReport: 'compact-report.md',
    });
  } catch (error) {
    const report = checkReport(
      result,
      { nodes: [], edges: [] },
      {
        documents: [],
        recheck,
        summary: `Native view unavailable: ${error.message}. Complete report: report.md; raw result: check-result.json.`,
      },
    );
    await json('check-report.json', report);
    await json('run.json', {
      exit: checked.exit,
      status: report.status,
      nativeView: false,
      compactReport: 'compact-report.md',
      nativeViewError: error.message,
    });
  }
} catch (error) {
  await writeFile(
    join(stage, 'worker-error.txt'),
    error?.message ?? inspect(error),
  );
  process.exitCode = 2;
}
