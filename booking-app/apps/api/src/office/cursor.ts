import { AppError } from '../common/errors/app-error.js';

/**
 * Keyset pagination.
 *
 * Offset paging silently lies while a list is being written to: a booking created
 * between page one and page two shifts every later row, so one row is skipped and
 * another repeated, and nobody notices because both pages look plausible. A keyset
 * cursor carries the last row's sort value *and* its id, so page two asks for "strictly
 * after that row" rather than "from position 25".
 *
 * The id is always the final sort key, which is what makes the order **total**. Two
 * bookings can start at the same instant; without the tie-break their relative order is
 * whatever PostgreSQL happens to return, and a cursor pointing at one of them cannot say
 * which side of it the other falls on.
 */

export interface Cursor {
  /** The sort column's value, as a string, so one encoding serves dates and text. */
  value: string;
  id: string;
}

export type SortDirection = 'asc' | 'desc';

export function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
}

/**
 * Decode, refusing anything that is not one of ours.
 *
 * A cursor is opaque and clients must not construct one, so a malformed value is a
 * client error rather than something to recover from — but it must be a *400*, not the
 * 500 that a bare `JSON.parse` on user input produces.
 */
export function decodeCursor(raw: string): Cursor {
  const reject = (): never => {
    throw new AppError('VALIDATION_FAILED', {
      message: 'That cursor is not valid. Start from the first page.',
      details: { issues: [{ path: ['cursor'], message: 'malformed', code: 'invalid_cursor' }] },
    });
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
  } catch {
    return reject();
  }

  if (parsed === null || typeof parsed !== 'object') return reject();

  const { value, id } = parsed as { value?: unknown; id?: unknown };
  if (typeof value !== 'string' || typeof id !== 'string') return reject();

  return { value, id };
}

/**
 * The `where` fragment that means "strictly after this row in this order".
 *
 * Two branches, not one: rows whose sort value is past the cursor's, plus rows that tie
 * on it and whose id is past the cursor's. Collapsing that into a single comparison is
 * the classic keyset bug — it drops every tied row after the first.
 */
export function keysetWhere(
  field: string,
  direction: SortDirection,
  cursor: Cursor,
): Record<string, unknown> {
  const operator = direction === 'asc' ? 'gt' : 'lt';
  const boundary = isIsoInstant(cursor.value) ? new Date(cursor.value) : cursor.value;

  return {
    OR: [
      { [field]: { [operator]: boundary } },
      { [field]: boundary, id: { [operator]: cursor.id } },
    ],
  };
}

/** The total order: the requested column, then the id. */
export function keysetOrderBy(
  field: string,
  direction: SortDirection,
): Record<string, SortDirection>[] {
  return [{ [field]: direction }, { id: direction }];
}

/**
 * Turn `limit + 1` rows into a page.
 *
 * Reading one more row than asked for is how `nextCursor` becomes `null` on the last
 * page without a second `count` query — and a count would be wrong anyway, since it
 * answers about a moment that has already passed.
 */
export function toPage<Row extends { id: string }>(
  rows: Row[],
  limit: number,
  sortValue: (row: Row) => string,
): { items: Row[]; nextCursor: string | null } {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items.at(-1);

  return {
    items,
    nextCursor:
      hasMore && last !== undefined ? encodeCursor({ value: sortValue(last), id: last.id }) : null,
  };
}

/** Instants are stored as dates; anything else compares as text. */
function isIsoInstant(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value);
}
