/** Used when a display name has no ASCII to make a slug out of. See `slugifyOrFallback`. */
const SLUG_FALLBACK = 'org';

/**
 * URL-safe slug for an organization's display name.
 *
 * Diacritics are stripped rather than kept: `Café` and `Cafe` would otherwise
 * produce visually similar but byte-different slugs, and a slug is meant to be
 * typed and compared as plain ASCII.
 *
 * Returns an empty string for a name with no ASCII letters or digits at all —
 * `東京`, `///`. Callers that need a usable address must go through
 * `slugifyOrFallback`.
 */
export function slugify(input: string): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * A slug that is always addressable, whatever the display name was.
 *
 * `東京`, `株式会社`, `///` and `"   "` all normalize to nothing. Storing that empty
 * result gives the organization the slug `''`, and `?organizer=` is not treated as an
 * identity at all — so the organization would be publicly unreachable while the link
 * that was meant to reach it quietly served the bootstrap tenant instead. Rejecting the
 * name would be the wrong answer: 東京 is a perfectly good business name, it just has no
 * ASCII in it. The registration's existing collision retry turns repeats of the fallback
 * into `org-a1b2c3`.
 */
export function slugifyOrFallback(input: string): string {
  const slug = slugify(input);
  return slug === '' ? SLUG_FALLBACK : slug;
}

/** Short random suffix appended to a slug on a collision retry. */
export function slugSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}
