import { describe, expect, it } from 'vitest';

import { slugify, slugifyOrFallback } from './slug.js';

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

  it.each(['東京', '株式会社', '///', '   '])('has nothing to work with in %j', (name) => {
    expect(slugify(name)).toBe('');
  });
});

describe('slugifyOrFallback', () => {
  it('keeps a real slug untouched', () => {
    expect(slugifyOrFallback('Acme Studio')).toBe('acme-studio');
  });

  // An empty slug is not a cosmetic problem: `?organizer=` is not read as an identity at
  // all, so the organization would be unreachable while its link served the bootstrap
  // tenant's catalogue instead.
  it.each(['東京', '株式会社', '///', '   '])('never returns an empty slug for %j', (name) => {
    expect(slugifyOrFallback(name)).not.toBe('');
  });
});
