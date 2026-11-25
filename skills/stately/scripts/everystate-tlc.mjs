// Opt-in everystate backend. The engine runs `JAVA ... -cp JAR <main> args`; this
// module writes a launcher that the engine uses as JAVA. SANY still runs on Java.
// TLC runs go to everystate with the same arguments, and its trace headers are
// rewritten to TLC's form so views receive the same action names.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = fileURLToPath(import.meta.url);
const quote = (value) => `'${String(value).replaceAll("'", `'\\''`)}'`;

// everystate names a step `Bump(1)` where TLC 1.7.4 writes `Bump`, in state
// headers and in the `Back to state:` line that closes a liveness loop.
export function tlcActionHeaders(text) {
  const header = /^((?:State )?\d+: (?:Back to state: )?<)([^\s(<>]+)\(/gm;
  let out = '';
  let last = 0;
  for (let m; (m = header.exec(text)); ) {
    let i = header.lastIndex;
    let depth = 1;
    let quoted = false;
    for (; i < text.length && depth && text[i] !== '\n'; i++) {
      const c = text[i];
      if (quoted) {
        if (c === '\\') i++;
        else if (c === '"') quoted = false;
      } else if (c === '"') quoted = true;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    if (depth || !text.startsWith(' line ', i)) continue;
    out += text.slice(last, m.index) + m[1] + m[2];
    last = header.lastIndex = i;
  }
  return out + text.slice(last);
}

// npm installs a JavaScript launcher that starts the native binary for this
// platform. Run and hash that binary, which is what checks the model.
function nativeBinary(binary) {
  const found = binary.includes('/')
    ? binary
    : spawnSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', binary], {
        encoding: 'utf8',
      }).stdout.trim();
  if (!found || !existsSync(found))
    throw Error(`STATELY_EVERYSTATE does not name a file: ${binary}`);
  const file = realpathSync(resolve(found));
  if (!readFileSync(file).subarray(0, 2).equals(Buffer.from('#!'))) return file;
  const platform = `${process.platform}-${process.arch}`;
  const native =
    process.env.EVERYSTATE_BINARY ??
    join(dirname(file), '..', 'native', platform, 'everystate');
  if (!existsSync(native))
    throw Error(
      `STATELY_EVERYSTATE names a launcher script with no ${platform} binary: ${file}`,
    );
  return realpathSync(resolve(native));
}

export function prepareEverystate({ binary, java, cache }) {
  if (process.platform === 'win32')
    throw Error('STATELY_EVERYSTATE is supported on Linux and macOS.');
  const located = nativeBinary(binary);
  const probe = spawnSync(located, ['--version'], { encoding: 'utf8' });
  const version = probe.stdout?.match(/^everystate (\S+)/)?.[1];
  if (probe.error || probe.status !== 0 || !version)
    throw Error(
      `STATELY_EVERYSTATE does not run everystate: ${located}` +
        (probe.error ? ` (${probe.error.message})` : ''),
    );
  const sha256 = createHash('sha256')
    .update(readFileSync(located))
    .digest('hex');
  const runtime = process.versions.deno
    ? ['run', '--quiet', '--no-prompt', '--allow-all']
    : process.execArgv;
  const script = `#!/bin/sh\nexec ${[process.execPath, ...runtime, here]
    .map(quote)
    .join(' ')} "$@"\n`;
  // The cache already holds the Java and TLC that run, so it allows execution
  // where a temporary folder may not.
  mkdirSync(cache, { recursive: true });
  const digest = createHash('sha256').update(script).digest('hex');
  const launcher = join(cache, `everystate-java-${digest.slice(0, 16)}`);
  if (!existsSync(launcher)) {
    const partial = `${launcher}.${process.pid}`;
    writeFileSync(partial, script, { mode: 0o755 });
    renameSync(partial, launcher);
  }
  process.env.STATELY_EVERYSTATE_BINARY = located;
  process.env.STATELY_EVERYSTATE_JAVA = java;
  return { launcher, binary: located, version, sha256 };
}

function main(args) {
  const cp = args.indexOf('-cp');
  const entry = args[cp + 2];
  if (entry !== 'tlc2.TLC') {
    const r = spawnSync(process.env.STATELY_EVERYSTATE_JAVA, args, {
      stdio: 'inherit',
    });
    return r.error ? 2 : (r.status ?? 1);
  }
  const library = args
    .find((arg) => arg.startsWith('-DTLA-Library='))
    ?.slice('-DTLA-Library='.length);
  // TLC finds the user's modules through TLA-Library; everystate reads the working folder.
  if (library)
    for (const file of readdirSync(library))
      if (file.endsWith('.tla') && !existsSync(file))
        copyFileSync(join(library, file), file);
  const r = spawnSync(
    process.env.STATELY_EVERYSTATE_BINARY,
    args.slice(cp + 3),
    { encoding: 'utf8', maxBuffer: 1 << 30 },
  );
  if (r.error) {
    process.stderr.write(`everystate: ${r.error.message}\n`);
    return 2;
  }
  process.stdout.write(tlcActionHeaders(r.stdout));
  process.stderr.write(r.stderr);
  return r.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === here)
  process.exitCode = main(process.argv.slice(2));
