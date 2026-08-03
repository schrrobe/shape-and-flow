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
});
