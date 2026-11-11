import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import {
  open,
  access,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const exec = (file, args, options = {}) =>
  new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { encoding: 'utf8', windowsHide: true, ...options },
      (error, stdout, stderr) => {
        if (error) reject(Object.assign(error, { stdout, stderr }));
        else resolve({ stdout, stderr });
      },
    );
  });
export const TLC_VERSION = '1.7.4';
export const TLC_SHA256 =
  '936a262061c914694dfd669a543be24573c45d5aa0ff20a8b96b23d01e050e88';
export const PELE_VERSION = '1.9.0';
export const PELE_SHA256 =
  '7c40a25eeaf4370fb56c03d9d8f6780051c9c39b6c6ca36d53239075117097f5';
/** Worker stderr lines with this prefix are forwarded to the user as progress. */
export const PROGRESS_PREFIX = 'stately-progress: ';
export const toolchainCache = () =>
  resolve(
    process.env.STATELY_CACHE_DIR ??
      join(homedir(), '.cache', 'stately', 'check'),
  );
const tlcURL = `https://github.com/tlaplus/tlaplus/releases/download/v${TLC_VERSION}/tla2tools.jar`;
const megabytes = (bytes) =>
  Number.isFinite(bytes) && bytes > 0
    ? ` (${Math.max(1, Math.round(bytes / 1_000_000))} MB)`
    : '';
const exists = (file) =>
  access(file).then(
    () => true,
    () => false,
  );
const digest = async (file) => {
  const hash = createHash('sha256');
  for await (const bytes of createReadStream(file)) hash.update(bytes);
  return hash.digest('hex');
};
async function download(url, file, checksum, limit = 200_000_000, signal) {
  if (new URL(url).protocol !== 'https:')
    throw Error('Toolchain downloads require HTTPS.');
  const response = await fetch(url, {
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  });
  if (!response.ok || !response.body)
    throw Error(`Toolchain download failed (${response.status}): ${url}`);
  const hash = createHash('sha256');
  let size = 0;
  const reader = response.body.getReader();
  try {
    const handle = await open(file, 'wx');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > limit)
          throw Error('Toolchain download exceeds the size limit.');
        hash.update(value);
        for (let offset = 0; offset < value.byteLength; ) {
          const { bytesWritten } = await handle.write(
            value,
            offset,
            value.byteLength - offset,
            null,
          );
          if (!bytesWritten)
            throw Error('Cannot write the downloaded toolchain.');
          offset += bytesWritten;
        }
      }
    } finally {
      await handle.close();
    }
    if (hash.digest('hex') !== checksum)
      throw Error('Toolchain checksum mismatch.');
  } catch (error) {
    await reader.cancel().catch(() => {});
    await rm(file, { force: true });
    throw error;
  } finally {
    reader.releaseLock();
  }
}

async function javaVersion(java, signal) {
  try {
    const result = await exec(java, ['-version'], {
      timeout: 15_000,
      maxBuffer: 64_000,
      signal,
    });
    const text = `${result.stderr}\n${result.stdout}`.trim();
    const line = text
      .split('\n')
      .find((line) => /^(?:openjdk|java)(?:\s+version)?\s+"?\d/.test(line));
    const major = Number(line?.match(/(?:version\s+"|openjdk\s+)(\d+)/)?.[1]);
    return major >= 11 ? line : undefined;
  } catch {
    return undefined;
  }
}
async function findJava(directory) {
  const suffix = process.platform === 'win32' ? 'java.exe' : 'java';
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'bin' && (await exists(join(file, suffix))))
        return join(file, suffix);
      const found = await findJava(file);
      if (found) return found;
    }
  }
}
async function installJava(cache, signal, installDirectory, progress) {
  const os = { darwin: 'mac', linux: 'linux', win32: 'windows' }[
    process.platform
  ];
  const architecture = { arm64: 'aarch64', x64: 'x64' }[process.arch];
  if (!os || !architecture)
    throw Error('Set JAVA to a Java 11+ binary on this platform.');
  const response = await fetch(
    `https://api.adoptium.net/v3/assets/latest/25/hotspot?architecture=${architecture}&image_type=jre&os=${os}&vendor=eclipse`,
    {
      signal: signal
        ? AbortSignal.any([signal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000),
    },
  );
  if (!response.ok)
    throw Error(
      `Cannot provision Java (${response.status}); set JAVA to an installed Java 11+ binary.`,
    );
  const assets = await response.json();
  const asset = Array.isArray(assets) ? assets[0]?.binary?.package : undefined;
  if (
    !asset ||
    typeof asset.link !== 'string' ||
    !/^[a-f0-9]{64}$/.test(asset.checksum)
  )
    throw Error('Invalid Adoptium package metadata.');
  const destination = join(cache, `java-${asset.checksum}`);
  if (await exists(destination)) {
    const java = await findJava(destination);
    if (java && (await javaVersion(java, signal))) return java;
    throw Error(`Cached Java installation is incomplete: ${destination}`);
  }
  progress(
    `Downloading Temurin JRE 25${megabytes(asset.size)} into ${cache} ...`,
  );
  const stage = installDirectory ?? join(cache, `java-stage-${randomUUID()}`);
  await mkdir(stage);
  const archive = join(
    stage,
    process.platform === 'win32' ? 'java.zip' : 'java.tar.gz',
  );
  const contents = join(stage, 'contents');
  await mkdir(contents);
  try {
    await download(asset.link, archive, asset.checksum, 200_000_000, signal);
    progress('Unpacking Temurin JRE 25 ...');
    if (process.platform === 'win32') {
      await exec(
        'powershell',
        [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          'Expand-Archive -LiteralPath $env:STATELY_JAVA_ARCHIVE -DestinationPath $env:STATELY_JAVA_DESTINATION',
        ],
        {
          env: {
            ...process.env,
            STATELY_JAVA_ARCHIVE: archive,
            STATELY_JAVA_DESTINATION: contents,
          },
          timeout: 120_000,
          signal,
        },
      );
    } else {
      await exec('tar', ['-xzf', archive, '-C', contents], {
        timeout: 120_000,
        signal,
      });
    }
    const java = await findJava(contents);
    if (!java || !(await javaVersion(java, signal)))
      throw Error('Downloaded archive has no usable Java 11+ binary.');
    await writeFile(
      join(contents, 'stately-install.json'),
      JSON.stringify({ url: asset.link, sha256: asset.checksum }),
    );
    try {
      await rename(contents, destination);
    } catch (error) {
      if (!(await exists(destination))) throw error;
    }
    return await findJava(destination);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Optional standalone renderer; no package-manager or workspace install required. */
export async function ensureRenderer({
  offline = false,
  signal,
  cache = toolchainCache(),
  progress = () => {},
} = {}) {
  cache = resolve(cache);
  await mkdir(cache, { recursive: true });
  const file = join(cache, `pele-${PELE_VERSION}.mjs`);
  if (!(await exists(file))) {
    if (offline)
      throw Error(
        'Pele renderer is not cached; render once without --offline.',
      );
    progress(`Downloading Pele renderer ${PELE_VERSION} ...`);
    const stage = `${file}.${randomUUID()}.tmp`;
    try {
      await download(
        `https://cdn.jsdelivr.net/npm/pele@${PELE_VERSION}/dist/pele.js`,
        stage,
        PELE_SHA256,
        2_000_000,
        signal,
      );
      try {
        await rename(stage, file);
      } catch (error) {
        if (!(await exists(file)) || (await digest(file)) !== PELE_SHA256)
          throw error;
      }
    } finally {
      await rm(stage, { force: true });
    }
    progress('Ready');
  }
  if ((await digest(file)) !== PELE_SHA256)
    throw Error(
      'Cached Pele checksum mismatch; remove the corrupt renderer and retry.',
    );
  return { file, version: PELE_VERSION, sha256: PELE_SHA256 };
}

export const XSTATE_VERSION = '6.0.0-alpha.65';
/** The ESM entry and the chunks it imports, from the published package. */
export const XSTATE_FILES = {
  'xstate.esm.js':
    '7ece27cc5e9465d5d070c1394dc4eef4dfebb6be03b6dead4286003d956f58f6',
  'index-52ad3d45.esm.js':
    '448f9d5df0eff4a9c0c3b3f8b31b54ddf49b36f12ee0ccab4f230b955d79f21c',
  'createActor-4629a290.esm.js':
    '49e5c95884c91c467b028393b9569fd09bf5ee4132e228acd6197fb218951f2c',
  'schema.types-0ecd17b8.esm.js':
    '0367ede5890c4cbdd62fd5c6faac12095328ed252e587c485d2d45ba3ee55f54',
  'effectDescriptor-973fc1ba.esm.js':
    '6b4b0e9546f7cabfab977828602411866d3b54f71abf67b985ad6353ee6dec73',
};

/**
 * XState v6 for the native checker: a checksum-verified copy of the published ESM
 * build in the Stately cache, no package manager or workspace install required.
 * Returns the cached entry file to `import()`.
 */
export async function ensureXState({
  offline = false,
  signal,
  cache = toolchainCache(),
  progress = () => {},
} = {}) {
  cache = resolve(cache);
  const directory = join(cache, `xstate-${XSTATE_VERSION}`);
  await mkdir(directory, { recursive: true });
  let announced = false;
  for (const [name, sha256] of Object.entries(XSTATE_FILES)) {
    const file = join(directory, name);
    if ((await exists(file)) && (await digest(file)) === sha256) continue;
    if (offline)
      throw Error(
        `XState ${XSTATE_VERSION} is not cached; run once without --offline.`,
      );
    if (!announced) progress(`Downloading XState ${XSTATE_VERSION} ...`);
    announced = true;
    await rm(file, { force: true });
    const stage = `${file}.${randomUUID()}.tmp`;
    try {
      await download(
        `https://cdn.jsdelivr.net/npm/xstate@${XSTATE_VERSION}/dist/${name}`,
        stage,
        sha256,
        2_000_000,
        signal,
      );
      try {
        await rename(stage, file);
      } catch (error) {
        if (!(await exists(file)) || (await digest(file)) !== sha256)
          throw error;
      }
    } finally {
      await rm(stage, { force: true });
    }
  }
  if (announced) progress('Ready');
  return {
    file: join(directory, 'xstate.esm.js'),
    version: XSTATE_VERSION,
    files: XSTATE_FILES,
  };
}

/** Local, checksum-verified toolchain; no pstack or mise installation required. */
export async function ensureToolchain({
  offline = false,
  signal,
  cache = toolchainCache(),
  installDirectory,
  progress = () => {},
} = {}) {
  let downloaded = false;
  cache = resolve(cache);
  await mkdir(cache, { recursive: true });
  const configuredJava = process.env.STATELY_TLC_JAVA ?? process.env.JAVA;
  let java = configuredJava ?? 'java';
  let version = await javaVersion(java, signal);
  if (!version && !configuredJava) {
    for (const entry of (await readdir(cache, { withFileTypes: true })).filter(
      (item) => item.isDirectory() && /^java-[a-f0-9]{64}$/.test(item.name),
    )) {
      const candidate = await findJava(join(cache, entry.name));
      if (candidate && (await javaVersion(candidate, signal))) {
        java = candidate;
        version = await javaVersion(java, signal);
        break;
      }
    }
  }
  if (!version) {
    if (configuredJava || offline)
      throw Error(
        'A usable Java 11+ binary was not found; set JAVA or permit automatic Java provisioning.',
      );
    java = await installJava(cache, signal, installDirectory, progress);
    downloaded = true;
    version = await javaVersion(java, signal);
  }
  const configuredJar = process.env.STATELY_TLC_JAR ?? process.env.TLA2TOOLS;
  const jar = configuredJar
    ? resolve(configuredJar)
    : join(cache, `tla2tools-${TLC_VERSION}.jar`);
  if (!(await exists(jar))) {
    if (configuredJar || offline)
      throw Error(
        `TLC jar not found: ${jar}. Set TLA2TOOLS or run without --offline.`,
      );
    progress(`Downloading TLC ${TLC_VERSION} (2 MB) ...`);
    downloaded = true;
    const stage = `${jar}.${randomUUID()}.tmp`;
    await download(tlcURL, stage, TLC_SHA256, 20_000_000, signal);
    try {
      await rename(stage, jar);
    } finally {
      await rm(stage, { force: true });
    }
  }
  const sha256 = await digest(jar);
  if (!configuredJar && sha256 !== TLC_SHA256)
    throw Error(
      'Cached TLC checksum mismatch; remove the corrupt cached jar and retry.',
    );
  const result = await exec(java, ['-cp', jar, 'tlc2.TLC', '-version'], {
    timeout: 15_000,
    maxBuffer: 128_000,
    signal,
  }).catch((error) => {
    // TLC 1.7.4 prints its version before rejecting this option with exit 1.
    if (
      error.code === 1 &&
      /TLC2 Version/.test(`${error.stdout}\n${error.stderr}`)
    )
      return error;
    throw error;
  });
  const tlcVersion = `${result.stdout}\n${result.stderr}`.match(
    /TLC2 Version[^\n]*/,
  )?.[0];
  if (!tlcVersion) throw Error('Cannot identify the configured TLC checker.');
  if (downloaded) progress('Ready');
  return { java, jar, javaVersion: version, version: tlcVersion, sha256 };
}
