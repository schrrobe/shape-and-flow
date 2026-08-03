import { describe, expect, it } from 'vitest';

import { canonicalRequestHash, canonicalRequestJson } from './request-hash.js';

describe('canonicalRequestHash', () => {
  it('is stable under key order', () => {
    expect(canonicalRequestHash({ a: 1, b: 2 })).toBe(canonicalRequestHash({ b: 2, a: 1 }));
  });

  it('is stable under nested key order', () => {
    expect(canonicalRequestHash({ c: { x: 1, y: 2 } })).toBe(
      canonicalRequestHash({ c: { y: 2, x: 1 } }),
    );
  });

  it('is stable under key order inside an array element', () => {
    expect(canonicalRequestHash({ items: [{ x: 1, y: 2 }] })).toBe(
      canonicalRequestHash({ items: [{ y: 2, x: 1 }] }),
    );
  });

  it('normalises the customer email case and surrounding whitespace', () => {
    // The same person typing their address differently is the same request.
    expect(canonicalRequestHash({ customer: { email: ' Anna@Example.COM ' } })).toBe(
      canonicalRequestHash({ customer: { email: 'anna@example.com' } }),
    );
  });

  it('normalises an email at any depth, and only a field called email', () => {
    expect(canonicalRequestHash({ email: 'A@B.COM' })).toBe(
      canonicalRequestHash({ email: 'a@b.com' }),
    );
    // A name is not an email: its case is preserved.
    expect(canonicalRequestHash({ name: 'Anna' })).not.toBe(canonicalRequestHash({ name: 'anna' }));
  });

  it('distinguishes a different slot', () => {
    expect(canonicalRequestHash({ startsAt: '2026-08-14T07:00:00.000Z' })).not.toBe(
      canonicalRequestHash({ startsAt: '2026-08-14T07:15:00.000Z' }),
    );
  });

  it('distinguishes the route target when two requests have the same body', () => {
    expect(canonicalRequestHash({ reason: 'Closed' }, { id: 'booking-1' })).not.toBe(
      canonicalRequestHash({ reason: 'Closed' }, { id: 'booking-2' }),
    );
  });

  it('distinguishes null from absent', () => {
    // `{ employeeId: null }` asks for automatic assignment; `{}` may mean the field
    // was never sent. Replaying one for the other would answer a different question.
    expect(canonicalRequestHash({ employeeId: null })).not.toBe(canonicalRequestHash({}));
  });

  it('treats an explicitly undefined field as absent, matching JSON', () => {
    // JSON cannot carry `undefined`, so a body that reached us over HTTP never has
    // one. This only matters for a hash computed in-process.
    expect(canonicalRequestHash({ employeeId: undefined })).toBe(canonicalRequestHash({}));
  });

  it('preserves array order', () => {
    expect(canonicalRequestHash({ a: [1, 2] })).not.toBe(canonicalRequestHash({ a: [2, 1] }));
  });

  it('distinguishes a string from the number that looks like it', () => {
    expect(canonicalRequestHash({ a: 1 })).not.toBe(canonicalRequestHash({ a: '1' }));
  });

  it('distinguishes an empty body from a body with an empty object', () => {
    expect(canonicalRequestHash({})).not.toBe(canonicalRequestHash({ customer: {} }));
  });

  it('handles a body that is not an object at all', () => {
    expect(canonicalRequestHash(null)).toBe(canonicalRequestHash(null));
    expect(canonicalRequestHash(null)).not.toBe(canonicalRequestHash({}));
    expect(canonicalRequestHash('text')).not.toBe(canonicalRequestHash({ 0: 'text' }));
  });

  it('normalises an absent top-level body to JSON null', () => {
    expect(canonicalRequestJson(undefined)).toBe('null');
    expect(canonicalRequestHash(undefined)).toBe(canonicalRequestHash(null));
  });

  it('produces a hex sha256', () => {
    expect(canonicalRequestHash({ a: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('canonicalRequestJson', () => {
  it('sorts keys at every level so a mismatch can be read by eye', () => {
    expect(canonicalRequestJson({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });

  it('shows the normalised email, which is what the hash actually covered', () => {
    expect(canonicalRequestJson({ email: '  Anna@Example.com ' })).toBe(
      '{"email":"anna@example.com"}',
    );
  });
});
