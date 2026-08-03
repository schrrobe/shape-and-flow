import { describe, expect, it } from 'vitest';

import { isAppError } from '../common/errors/app-error.js';

import { decodeCursor, encodeCursor, keysetOrderBy, keysetWhere, toPage } from './cursor.js';

describe('encode and decode', () => {
  it('round-trips', () => {
    const cursor = { value: '2026-08-14T20:00:00.000Z', id: 'ckabc123' };

    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('rejects a malformed cursor as a client error, not a crash', () => {
    // A bare JSON.parse on user input is a 500 waiting to happen, and the cursor is the
    // one opaque value a client is most likely to truncate or hand-edit.
    for (const bad of ['', 'not-base64!!', Buffer.from('null').toString('base64url')]) {
      try {
        decodeCursor(bad);
        expect.unreachable(`expected ${bad} to be rejected`);
      } catch (error) {
        expect(isAppError(error, 'VALIDATION_FAILED'), bad).toBe(true);
      }
    }
  });

  it('rejects a well-formed object missing a field', () => {
    const partial = Buffer.from(JSON.stringify({ value: 'x' })).toString('base64url');

    expect(
      isAppError(
        catchError(() => decodeCursor(partial)),
        'VALIDATION_FAILED',
      ),
    ).toBe(true);
  });
});

describe('keysetWhere', () => {
  it('asks for rows past the value, plus ties broken by id', () => {
    // One comparison instead of two is the classic keyset bug: it drops every row that
    // ties with the cursor on the sort column.
    const where = keysetWhere('startsAt', 'asc', {
      value: '2026-08-14T20:00:00.000Z',
      id: 'ckabc',
    });

    expect(where).toEqual({
      OR: [
        { startsAt: { gt: new Date('2026-08-14T20:00:00.000Z') } },
        { startsAt: new Date('2026-08-14T20:00:00.000Z'), id: { gt: 'ckabc' } },
      ],
    });
  });

  it('flips both comparisons for a descending sort', () => {
    const where = keysetWhere('createdAt', 'desc', {
      value: '2026-08-14T20:00:00.000Z',
      id: 'ckabc',
    }) as { OR: Record<string, { lt?: unknown }>[] };

    expect(where.OR[0]?.createdAt?.lt).toEqual(new Date('2026-08-14T20:00:00.000Z'));
    expect(where.OR[1]?.id?.lt).toBe('ckabc');
  });

  it('compares a non-instant value as text', () => {
    const where = keysetWhere('reference', 'asc', { value: 'SF-ABC', id: 'ckabc' }) as {
      OR: Record<string, { gt?: unknown }>[];
    };

    expect(where.OR[0]?.reference?.gt).toBe('SF-ABC');
  });
});

describe('keysetOrderBy', () => {
  it('always ends with the id, so the order is total', () => {
    expect(keysetOrderBy('startsAt', 'desc')).toEqual([{ startsAt: 'desc' }, { id: 'desc' }]);
  });
});

describe('toPage', () => {
  const rows = [
    { id: 'a', createdAt: '1' },
    { id: 'b', createdAt: '2' },
    { id: 'c', createdAt: '3' },
  ];

  it('trims the extra row and points the cursor at the last kept one', () => {
    const page = toPage(rows, 2, (row) => row.createdAt);

    expect(page.items.map((row) => row.id)).toEqual(['a', 'b']);
    expect(page.nextCursor).not.toBeNull();
    expect(decodeCursor(page.nextCursor ?? '')).toEqual({ value: '2', id: 'b' });
  });

  it('reports no next page when the extra row is absent', () => {
    expect(toPage(rows, 3, (row) => row.createdAt).nextCursor).toBeNull();
  });

  it('reports no next page for an empty result', () => {
    expect(toPage([], 10, () => '')).toEqual({ items: [], nextCursor: null });
  });
});

function catchError(run: () => unknown): unknown {
  try {
    run();
    return undefined;
  } catch (error) {
    return error;
  }
}
