import { execFile } from 'node:child_process';
import {
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { parseCheckResult } from './check-result.mjs';
const exec = (file, args, options = {}) =>
  new Promise((resolve, reject) =>
    execFile(
      file,
      args,
      {
        encoding: 'utf8',
        timeout: process.platform === 'win32' ? 15000 : 5000,
        maxBuffer: 2_000_000,
        windowsHide: true,
        ...options,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    ),
  );

/** Native Windows cwd/antivirus locks can outlive the terminated writer. */
export async function removeOwnedDirectory(directory) {
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(directory, { recursive: true, force: true });
      try {
        await lstat(directory);
      } catch (error) {
        if (
          ['ENOENT', 'ENOTDIR'].includes(error.code) ||
          error.name === 'NotFound'
        )
          return;
        throw error;
      }
      throw Object.assign(
        Error(`Filesystem still reports ${directory} after removal.`),
        { code: 'STILL_PRESENT' },
      );
    } catch (error) {
      if (
        attempt >= 40 ||
        !(
          ['EBUSY', 'ENOTEMPTY', 'EACCES', 'EPERM', 'STILL_PRESENT'].includes(
            error.code,
          ) ||
          ['Busy', 'PermissionDenied', 'DirectoryNotEmpty'].includes(error.name)
        )
      )
        throw error;
      if (process.env.STATELY_LAUNCHER_DEBUG === '1')
        console.error(
          `Stately cleanup retry ${error.code ?? error.name}: ${directory}`,
        );
      await delay(250);
    }
  }
}

async function killGroup(pid) {
  if (process.platform === 'win32') {
    try {
      await exec('taskkill', ['/PID', String(pid), '/T', '/F']);
    } catch (error) {
      const status = Number(error.code);
      if (
        !Number.isInteger(status) ||
        status === 0 ||
        error.killed ||
        error.signal
      )
        throw error;
      const alive = await exec('powershell', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        `$ErrorActionPreference = 'Stop'; try { $target = Get-Process -Id ${pid} -ErrorAction Stop; if (-not $target.HasExited) { 'alive' } } catch { if ($_.FullyQualifiedErrorId -notlike 'NoProcessFoundForGivenId*') { throw } }; exit 0`,
      ]);
      if (alive.trim() === 'alive') throw error;
    }
    return;
  }
  // Bun 1.1.5 does not reliably signal a negative PID's whole group.
  // POSIX sh provides kill as a builtin even on images without procps.
  try {
    await exec(
      '/bin/sh',
      ['-c', 'kill -s KILL -- "$1"', 'stately-kill', `-${pid}`],
      { env: { ...process.env, LC_ALL: 'C' } },
    );
  } catch (error) {
    if (!/No such process|no such process/.test(error.message)) throw error;
  }
}

async function linuxOwnsGroup(pid, markers) {
  for (const name of await readdir('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, 'utf8');
      const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      if (Number(fields[2]) !== pid) continue;
      const command = await readFile(`/proc/${name}/cmdline`, 'utf8');
      if (markers.some((marker) => command.includes(marker))) return true;
    } catch (error) {
      if (!['ENOENT', 'ESRCH', 'EACCES', 'EPERM'].includes(error.code))
        throw error;
    }
  }
  return false;
}

/** Verify a unique request marker before signaling; cleanup failure never replaces a proof. */
export async function killOwnedGroup(pid, temporary, stage, liveChild) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { killed: false };
  const markers = [temporary, stage].filter(
    (marker) => typeof marker === 'string' && marker.length,
  );
  if (!markers.length) return { killed: false };
  let procfsFailure;
  try {
    if (process.platform === 'win32') {
      const code =
        'Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -ne $PID -and $_.CommandLine -and -not $_.CommandLine.Contains("check-janitor.mjs") -and ($_.CommandLine.Contains($env:STATELY_OWNED_TEMP) -or ($env:STATELY_OWNED_STAGE -and $_.CommandLine.Contains($env:STATELY_OWNED_STAGE))) } | Select-Object -ExpandProperty ProcessId';
      // Get-CimInstance can exceed its timeout on a loaded Windows host; a
      // timed-out listing proves nothing, so retry before reporting a warning.
      let output;
      for (let attempt = 1; ; attempt++) {
        try {
          output = await exec(
            'powershell',
            ['-NoProfile', '-NonInteractive', '-Command', code],
            {
              timeout: 30000,
              env: {
                ...process.env,
                STATELY_OWNED_TEMP: temporary,
                STATELY_OWNED_STAGE: stage ?? '',
              },
            },
          );
          break;
        } catch (error) {
          const timedOut = error.killed === true && error.signal === 'SIGTERM';
          if (!timedOut || attempt >= 3) throw error;
          await delay(500 * attempt);
        }
      }
      const ids = output
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter((id) => Number.isSafeInteger(id) && id > 0);
      for (const id of ids) await killGroup(id);
      return { killed: ids.length > 0 };
    }
    let owned;
    if (process.platform === 'linux') {
      try {
        owned = await linuxOwnsGroup(pid, markers);
      } catch (error) {
        procfsFailure = `${error.code ?? error.name}: ${error.message}`;
        if (process.env.STATELY_LAUNCHER_DEBUG === '1')
          console.error(
            `Stately procfs fallback: ${error.code ?? error.name}: ${error.message}`,
          );
      }
    }
    if (owned === undefined) {
      const listing = await exec(
        process.platform === 'darwin' ? '/bin/ps' : 'ps',
        ['-e', '-ww', '-o', 'pgid=', '-o', 'args='],
      );
      owned = listing.split('\n').some((line) => {
        const match = line.trim().match(/^(\d+)\s+(.*)$/);
        return (
          match &&
          Number(match[1]) === pid &&
          markers.some((marker) => match[2].includes(marker))
        );
      });
    }
    if (owned) await killGroup(pid);
    return { killed: Boolean(owned) };
  } catch (error) {
    let killed = false;
    if (
      liveChild?.pid === pid &&
      liveChild.exitCode === null &&
      liveChild.signalCode === null
    ) {
      try {
        await killGroup(pid);
        killed = true;
      } catch {}
    }
    return {
      killed,
      warning: `Could not verify owned process cleanup: ${error.code ?? error.name}: ${error.message}${error.signal ? ` (signal ${error.signal}; killed ${error.killed === true})` : ''}${procfsFailure ? ` (procfs: ${procfsFailure})` : ''}`,
    };
  }
}

/** Preserve completed checker checkpoints after publication/parent failure; remove unfinished inputs. */
export async function recoverOrRemoveStage(stage, output) {
  let completed;
  for (const name of ['check-result.json', 'check-result.raw.json']) {
    try {
      parseCheckResult(JSON.parse(await readFile(`${stage}/${name}`, 'utf8')));
      completed = name;
      break;
    } catch {}
  }
  if (completed) {
    const destination = `${output}.recovered-${basename(stage).replace('.stately-check-stage-', '')}`;
    try {
      await writeFile(
        `${stage}/RECOVERED.md`,
        `# Recovered checker artifacts\n\nThe parent stopped before publication. Completed checker evidence remains in ${completed}. No new application replay or successful native delivery is implied.\n`,
      );
      await rename(stage, destination);
      return destination;
    } catch (error) {
      if (error.code === 'ENOENT') return;
      throw error;
    }
  }
  await removeOwnedDirectory(stage);
}
