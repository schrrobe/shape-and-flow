/**
 * URL-safe slug for an organization's display name.
 *
 * Diacritics are stripped rather than kept: `Café` and `Cafe` would otherwise
 * produce visually similar but byte-different slugs, and a slug is meant to be
 * typed and compared as plain ASCII.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Short random suffix appended to a slug on a collision retry. */
export function slugSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
