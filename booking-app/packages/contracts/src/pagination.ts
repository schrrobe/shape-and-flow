import { z } from 'zod';

/**
 * Cursor pagination.
 *
 * Cursor rather than offset for anything a long list drives: the cursor encodes
 * `{ createdAt, id }`, so inserts during paging cannot cause a row to be skipped
 * or repeated, which offset paging does silently.
 *
 * Calendar reads deliberately do not paginate. They take a bounded date range
 * instead and refuse one that is too wide, because paginating a calendar is a
 * worse interface than declining to draw four months at once.
 */
export const cursorQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  /** Opaque base64url of `{ createdAt, id }`. Clients must not construct one. */
  cursor: z.string().optional(),
});

export type CursorQuery = z.infer<typeof cursorQuerySchema>;

export function cursorPageSchema<Item extends z.ZodType>(item: Item) {
  return z.object({
    items: z.array(item),
    /** Absent when this is the last page. */
    nextCursor: z.string().nullable(),
  });
}
