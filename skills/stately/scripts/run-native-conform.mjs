// `stately-check conform MODEL.json --rules RULES.json --trace TRACE.jsonl --out DIR`:
// checks recorded application runs against a native model and its rules file.
import { lstat, mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256 } from './check-result.mjs';
import { loadCachedXState } from './native-check.mjs';
import { CONFORM_NAME, CONFORM_VERSION, RESULT_FORMAT, applicationChecks, conform, conformExitCode, conformReport } from './native-conform.mjs';

const text = async (file) => new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(await readFile(file));
const writeJson = (file, value) => writeFile(file, JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
const absent = (error) => error.code === 'ENOENT';

async function requireFile(path, what) {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    if (!absent(error)) throw error;
    throw Object.assign(Error(`${what} not found: ${path}.`), { code: 'ENOENT', path });
  }
  if (!info.isFile()) throw Object.assign(Error(`${what} is not a regular file: ${path}.`), { code: 'EISDIR', path });
}

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
    throw Object.assign(Error(`--out ${output} already exists and is not an empty directory. Choose a new --out; existing artifacts are preserved.`), {
      code: 'EEXIST',
      path: output,
    });
  return target;
}

export async function runNativeConform({ model, rules, traces, out, offline = false, maxFrontier }) {
  if (!model?.endsWith('.json')) throw Error('Pass a native model .json file.');
  if (!traces.length) throw Error('Pass at least one --trace TRACE.jsonl.');
  const modelPath = resolve(model);
  await requireFile(modelPath, 'Model');
  const rulesPath = resolve(rules ?? modelPath.replace(/\.json$/, '.rules.json'));
  await requireFile(rulesPath, 'Rules');
  const tracePaths = traces.map((file) => resolve(file));
  for (const file of tracePaths) await requireFile(file, 'Trace');
  const output = await emptyOutput(resolve(out ?? modelPath.replace(/\.json$/, '-conform')));

  const modelContent = await text(modelPath);
  const rulesContent = await text(rulesPath);
  const traceInputs = await Promise.all(
    tracePaths.map(async (file, index) => ({ file, path: `inputs/traces/${index + 1}-${basename(file)}`, text: await text(file) })),
  );
  const run = conform({
    model: JSON.parse(modelContent),
    rules: JSON.parse(rulesContent),
    traces: traceInputs.map(({ path, text: content, file }) => ({ path, text: content, name: basename(file) })),
    xstate: await loadCachedXState({ offline }),
    maxFrontier,
  });
  const result = {
    schemaVersion: RESULT_FORMAT,
    checker: { name: CONFORM_NAME, version: CONFORM_VERSION },
    inputs: [
      { role: 'model', path: 'inputs/model.json', sourcePath: modelPath, sha256: sha256(modelContent) },
      { role: 'rules', path: 'inputs/rules.json', sourcePath: rulesPath, sha256: sha256(rulesContent) },
      ...traceInputs.map(({ file, path, text: content }) => ({ role: 'trace', path, sourcePath: file, sha256: sha256(content) })),
    ],
    ...run,
  };
  const exit = conformExitCode(run);
  await mkdir(join(output, 'inputs/traces'), { recursive: true });
  await writeFile(join(output, 'inputs/model.json'), modelContent, { flag: 'wx' });
  await writeFile(join(output, 'inputs/rules.json'), rulesContent, { flag: 'wx' });
  for (const { path, text: content } of traceInputs) await writeFile(join(output, path), content, { flag: 'wx' });
  await writeJson(join(output, 'conform-result.json'), result);
  await writeFile(join(output, 'conform-report.md'), conformReport(run), { flag: 'wx' });
  await writeJson(join(output, 'app-checks.json'), applicationChecks(run));
  const summary = {
    checker: CONFORM_NAME,
    version: CONFORM_VERSION,
    exit,
    ...run.summary,
    output,
    report: join(output, 'conform-report.md'),
    result: join(output, 'conform-result.json'),
    appChecks: join(output, 'app-checks.json'),
  };
  await writeJson(join(output, 'run.json'), summary);
  return summary;
}

export function parseNativeConformArgs(args) {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      rules: { type: 'string' },
      trace: { type: 'string', multiple: true },
      out: { type: 'string' },
      'max-frontier': { type: 'string' },
      offline: { type: 'boolean' },
      json: { type: 'boolean' },
    },
  });
  if (positionals.length !== 1) throw Error('Pass exactly one model .json file.');
  const { trace = [], 'max-frontier': frontier, ...flags } = values;
  const maxFrontier = frontier === undefined ? undefined : Number(frontier);
  if (maxFrontier !== undefined && !(Number.isInteger(maxFrontier) && maxFrontier > 0)) throw Error('--max-frontier must be a positive integer.');
  return { ...flags, model: positionals[0], traces: trace, maxFrontier };
}
