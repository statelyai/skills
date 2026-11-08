import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { resolve, relative, isAbsolute } from 'node:path';
import { parseCheckResult, sha256 } from './check-result.mjs';
import { serializeCheckView } from './check-view.mjs';
const inside = (root, file) => {
  const path = relative(root, file);
  return (
    path !== '..' &&
    !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) &&
    !isAbsolute(path)
  );
};

/** Resolve only bound inputs within an explicitly selected physical workspace. */
export async function currentSourceHashes(input, workspace = process.cwd()) {
  const result = parseCheckResult(input);
  const root = await realpath(resolve(workspace));
  const bindings = result.recheck?.sourceFiles ?? [];
  if (
    !Array.isArray(bindings) ||
    new Set(bindings.map((item) => item.path)).size !== bindings.length
  )
    throw Error('Source mapping paths must be unique.');
  const mapped = new Map(bindings.map((item) => [item.path, item.sourcePath]));
  const currentArtifacts = [],
    missing = [],
    changed = [],
    unknown = [];
  for (const artifact of result.binding.artifacts.filter((item) =>
    ['model', 'spec', 'config', 'view', 'scope'].includes(item.role),
  )) {
    const source = mapped.get(artifact.path);
    if (typeof source !== 'string') {
      unknown.push(artifact.path);
      continue;
    }
    const file = resolve(root, source);
    if (!inside(root, file))
      throw Error(
        `Bound source is outside this workspace: ${artifact.path}. Use the correct project; never broaden the workspace to follow metadata.`,
      );
    let physical;
    try {
      physical = await realpath(file);
    } catch (error) {
      if (error.code === 'ENOENT') {
        missing.push(artifact.path);
        currentArtifacts.push({ path: artifact.path, sha256: null });
        continue;
      }
      throw error;
    }
    if (!inside(root, physical))
      throw Error(
        `Bound source symlink escapes this workspace: ${artifact.path}`,
      );
    if (!(await stat(physical)).isFile())
      throw Error(`Bound source is not a regular file: ${artifact.path}`);
    const hash = createHash('sha256');
    for await (const chunk of createReadStream(physical)) hash.update(chunk);
    const digest = hash.digest('hex');
    currentArtifacts.push({ path: artifact.path, sha256: digest });
    if (digest !== artifact.sha256) changed.push(artifact.path);
  }
  return {
    status:
      changed.length || missing.length
        ? 'stale'
        : unknown.length || !currentArtifacts.length
          ? 'unknown'
          : 'current',
    workspace: root,
    comparedAt: new Date().toISOString(),
    currentArtifacts,
    changed,
    missing,
    unknown,
  };
}

/** Attach host-reported actual observations without resealing or executing a command. */
export function withApplicationChecks(graph, checks) {
  const report = graph.data?.meta?.['@statelyai.checkReport'];
  if (
    !report ||
    !report.viewSha256 ||
    report.viewSha256 !== sha256(serializeCheckView(graph))
  )
    throw Error(
      'Cannot attach current application evidence to an edited/unbound check view. Reconcile and recheck first.',
    );
  if (
    !Array.isArray(checks) ||
    checks.some(
      (check) =>
        !check ||
        typeof check.name !== 'string' ||
        !check.name ||
        check.name.length > 1024 ||
        !['passed', 'failed', 'not-run'].includes(check.status) ||
        typeof check.summary !== 'string' ||
        check.summary.length > 4000 ||
        (check.source !== undefined &&
          (typeof check.source !== 'string' || check.source.length > 4000)),
    )
  )
    throw Error(
      'Application checks require {name,status:passed|failed|not-run,summary,source?} records from actual application execution.',
    );
  const result = structuredClone(graph);
  result.data.meta['@statelyai.checkReport'].applicationChecks = checks;
  result.data.meta['@statelyai.checkReport'].summary = report.summary.replace(
    'Application replay has not run.',
    'Application evidence is recorded separately below.',
  );
  if (JSON.stringify(result).length > 195000)
    throw Error(
      'Application evidence exceeds the native budget; retain full local logs and attach only actual summaries/citations.',
    );
  return result;
}
