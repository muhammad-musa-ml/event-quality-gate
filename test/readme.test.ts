import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { END, START, renderAll, spliceReadme } from '../scripts/render-tables.js';
import { repoRoot } from '../scripts/paths.js';

const root = repoRoot();
const readme = readFileSync(join(root, 'README.md'), 'utf8');

describe('README.md and the result files', () => {
  it('has one results region, and it is exactly what the result files give', () => {
    expect(readme.split(START)).toHaveLength(2);
    expect(readme.split(END)).toHaveLength(2);
    expect(spliceReadme(readme, renderAll(root))).toBe(readme);
  });

  it('has results/TABLES.md equal to the same tables', () => {
    expect(readFileSync(join(root, 'results', 'TABLES.md'), 'utf8')).toBe(`${renderAll(root)}\n`);
  });

  it('puts each result table under a heading that names its source file', () => {
    for (const file of ['results/coverage/coverage.json', 'results/fault-injection/fault-injection.json', 'results/runtime/runtime.json']) {
      expect(readme).toContain(`\`${file}\``);
    }
  });

  it('says no first-person claim of a personal act', () => {
    const text = readme + readFileSync(join(root, 'results', 'TABLES.md'), 'utf8');
    expect(text).not.toMatch(/\bI (wrote|built|ran|measured|tested|found|checked|created|made)\b/);
    expect(text).not.toMatch(/\bmy (own|work|code|repo)\b/i);
  });
});
