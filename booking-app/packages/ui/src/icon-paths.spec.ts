import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { buildAll, WANTED } from '../scripts/extract-icons.js';

import { ICON_PATHS } from './icon-paths.js';

describe('the curated icon set', () => {
  it('matches what the Font Awesome package currently ships', () => {
    // Compared as data, not as text: the committed file is generated and then formatted by
    // Prettier, so a string comparison would fail on quoting rather than on a changed glyph.
    // What must not drift is the path data.
    expect(ICON_PATHS).toEqual(buildAll());
  });

  it('contains exactly the ten curated names', () => {
    expect(Object.keys(ICON_PATHS).sort()).toEqual(Object.keys(WANTED).sort());
  });

  it('gives every icon a viewBox and a non-trivial path', () => {
    for (const [name, data] of Object.entries(ICON_PATHS)) {
      expect(data.viewBox, name).toMatch(/^0 0 \d+ \d+$/);
      expect(data.path.length, name).toBeGreaterThan(50);
    }
  });

  it('embeds the paths rather than depending on Font Awesome at runtime', () => {
    // The point of generating: no webfont for ten glyphs, no runtime dependency, and no way
    // to reference an icon outside the set.
    const source = readFileSync(resolve(process.cwd(), 'src/icon-paths.ts'), 'utf8');

    expect(source).not.toContain('@fortawesome');
    expect(source).toContain('CC BY 4.0');
  });
});
