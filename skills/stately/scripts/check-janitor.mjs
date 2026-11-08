import { writeFileSync } from 'node:fs';
import {
  killOwnedGroup,
  recoverOrRemoveStage,
  removeOwnedDirectory,
} from './process-control.mjs';
const [initialPid, temporary, stage, output, bootstrapDirectory] =
  process.argv.slice(2);
let pid = Number(initialPid),
  completed = false,
  pending = '';
process.stdin.on('data', (bytes) => {
  pending += bytes.toString();
  let index;
  while ((index = pending.indexOf('\n')) >= 0) {
    const line = pending.slice(0, index);
    pending = pending.slice(index + 1);
    if (line === 'done') completed = true;
    if (/^worker:\d+$/.test(line)) pid = Number(line.slice(7));
  }
});
const ended = new Promise((resolve) => process.stdin.once('end', resolve));
process.stdin.resume();
await ended;
if (!completed) {
  const warnings = [];
  try {
    const cleanup = await killOwnedGroup(pid, temporary, stage);
    if (cleanup.warning) warnings.push(cleanup.warning);
    await recoverOrRemoveStage(stage, output);
  } catch (error) {
    warnings.push(
      `Could not recover checker artifacts: ${error.code ?? error.message}`,
    );
  } finally {
    for (const directory of [temporary, bootstrapDirectory].filter(Boolean)) {
      try {
        await removeOwnedDirectory(directory);
      } catch (error) {
        warnings.push(
          `Could not remove ${directory}: ${error.code ?? error.name}: ${error.message}`,
        );
      }
    }
    if (warnings.length) {
      try {
        writeFileSync(
          `${output}.cleanup-warning.json`,
          JSON.stringify({ warnings }, null, 2) + '\n',
          { flag: 'wx' },
        );
      } catch {
        /* Never overwrite an existing diagnostic or checker artifact. */
      }
    }
  }
}
