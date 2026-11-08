import { readFile, stat, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureRenderer } from './toolchain.mjs';
import { sha256 } from './check-result.mjs';

export async function renderChart({ input, out, offline = false }) {
  const sourcePath = resolve(input);
  if ((await stat(sourcePath)).size > 4_000_000)
    throw Error('Mermaid source exceeds the rendering limit.');
  const bytes = await readFile(sourcePath);
  const source = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const renderer = await ensureRenderer({ offline });
  const { render } = await import(pathToFileURL(renderer.file).href);
  const { svg } = render(source, {
    limit: 1_000_000,
    outputLimit: 8_000_000,
    maxEdges: 10_000,
  });
  const css = await readFile(new URL('./chart.css', import.meta.url), 'utf8');
  const styled = svg.replace(
    /<svg\b[^>]*>/,
    (opening) => `${opening}<style>${css}</style>`,
  );
  const suffix = extname(sourcePath);
  const output = resolve(
    out ?? (suffix ? sourcePath.slice(0, -suffix.length) : sourcePath) + '.svg',
  );
  await writeFile(output, styled, { flag: 'wx' });
  return {
    output,
    input: sourcePath,
    inputSha256: sha256(source),
    renderer: 'Pele',
    version: renderer.version,
    rendererSha256: renderer.sha256,
  };
}
