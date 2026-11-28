import { basename, relative, resolve, sep } from 'node:path';

/** Recheck paths are stored relative to the workspace root; never absolute. */
export const workspacePath = (file) =>
  relative(process.cwd(), resolve(file)).split(sep).join('/') || '.';

/** The workspace folder name only, never its absolute path. */
export const workspaceName = () => basename(process.cwd());
