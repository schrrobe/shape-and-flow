import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { envSchema } from './env.schema.js';

/**
 * Guards the promise made in .env.example: that it documents exactly the
 * variables the schema knows about. Without this, a new variable can be added
 * to the schema and silently never documented, and an operator only discovers
 * it when the process refuses to start.
 */
describe('.env.example', () => {
  const text = readFileSync(new URL('../../../../.env.example', import.meta.url), 'utf8');

  const documented = new Set(
    text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
      .map((line) => line.slice(0, line.indexOf('='))),
  );

  const declared = new Set(Object.keys(envSchema.shape));

  it('documents every variable the schema declares', () => {
    expect([...declared].filter((key) => !documented.has(key)).sort()).toEqual([]);
  });

  it('declares every variable the file documents', () => {
    expect([...documented].filter((key) => !declared.has(key)).sort()).toEqual([]);
  });

  it('is not empty, so a broken path cannot make this vacuously pass', () => {
    expect(documented.size).toBeGreaterThan(20);
    expect(declared.size).toBe(documented.size);
  });

  it('documents all five Unleash settings with non-secret placeholders', () => {
    const expected = [
      'UNLEASH_URL',
      'UNLEASH_BACKEND_TOKEN',
      'UNLEASH_FRONTEND_TOKEN',
      'UNLEASH_ENVIRONMENT',
      'UNLEASH_DEPLOYMENT',
    ];

    expect([...documented]).toEqual(expect.arrayContaining(expected));
    expect(text).toContain('UNLEASH_BACKEND_TOKEN=backend_replace_me');
    expect(text).toContain('UNLEASH_FRONTEND_TOKEN=frontend_replace_me');
  });
});

describe('.env.production.example', () => {
  const text = readFileSync(
    new URL('../../../../.env.production.example', import.meta.url),
    'utf8',
  );

  const entries = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[A-Z][A-Z0-9_]*=/.test(line))
    .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as const);

  const documented = new Set(entries.map(([key]) => key));

  /**
   * The file is what an operator copies to `.env.production`, and it picks providers —
   * `PAYMENT_PROVIDER=stripe` above all. Every credential those choices make mandatory has
   * to at least appear here, or the first anyone hears of a newly required variable is the
   * API refusing to start on the deploy that introduced it.
   *
   * Values are placeholders, so the parse fails either way; what is asserted is that no
   * complaint names a variable the file does not mention at all.
   */
  it('documents every variable the providers it selects make mandatory', () => {
    const parsed = envSchema.safeParse(Object.fromEntries(entries));
    const issues = parsed.success ? [] : parsed.error.issues;

    const undocumented = issues
      .map((issue) => String(issue.path[0]))
      .filter((key) => !documented.has(key));

    expect([...new Set(undocumented)].sort()).toEqual([]);
  });

  it('documents production-scoped Unleash placeholders', () => {
    expect(text).toContain('UNLEASH_URL=https://unleash.shapeandflow.de/api/');
    expect(text).toContain('UNLEASH_BACKEND_TOKEN=backend_production_replace_me');
    expect(text).toContain('UNLEASH_FRONTEND_TOKEN=frontend_production_replace_me');
    expect(text).toContain('UNLEASH_ENVIRONMENT=production');
    expect(text).toContain('UNLEASH_DEPLOYMENT=production');
  });
});
