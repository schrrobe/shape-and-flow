import { describe, expect, it } from 'vitest';

import { slugify } from './slug.js';

describe('slugify', () => {
  it('lowercases and hyphenates', () => {
    expect(slugify('Acme Studio')).toBe('acme-studio');
  });

  it('strips diacritics', () => {
    expect(slugify('Café Müller')).toBe('cafe-muller');
  });

  it('collapses repeated separators', () => {
    expect(slugify('  Acme   & Co.  ')).toBe('acme-co');
  });
});
