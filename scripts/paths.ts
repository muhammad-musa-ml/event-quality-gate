import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** True when the module at `metaUrl` is the file node was started with. */
export function isMain(metaUrl: string): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(metaUrl));
  } catch {
    return false;
  }
}

/** The folder that holds package.json, whether this runs from scripts/ or from dist/scripts/. */
export function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    if (existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'examples'))) return dir;
    dir = dirname(dir);
  }
  throw new Error('cannot find the repository root from ' + import.meta.url);
}
