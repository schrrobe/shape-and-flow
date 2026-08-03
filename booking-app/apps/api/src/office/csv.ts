/**
 * CSV for German Excel, which is a stricter target than RFC 4180 alone.
 *
 * Three decisions, each of which is the difference between a file that opens and one
 * that arrives as a single column of mush:
 *
 *  - **Semicolon**, not comma. Excel picks its delimiter from the machine's list
 *    separator, and on a German locale that is `;`. A comma-delimited file opens as one
 *    column per row.
 *  - **A UTF-8 BOM.** Without it Excel reads the bytes as the system code page, and
 *    every umlaut in every customer name becomes two characters.
 *  - **CRLF** line endings, which is what RFC 4180 specifies and what Excel writes.
 *
 * And one that is about safety rather than compatibility — see `neutralise`.
 */

/** Excel's list separator on a German machine. */
const CSV_DELIMITER = ';';

/** RFC 4180's line terminator. */
const CSV_NEWLINE = '\r\n';

/**
 * The byte-order mark, as a string.
 *
 * Prepended to the response body rather than set as a header, because it is data: a
 * client that saves the stream to disk has to get it too.
 */
export const CSV_BOM = '﻿';

/** A cell needs quoting when it contains the delimiter, a quote, or a line break. */
const NEEDS_QUOTING = new RegExp(`[${CSV_DELIMITER}"\\r\\n]`);

/** A leading character a spreadsheet may read as the start of a formula. */
const FORMULA_LEAD = /^[=+\-@\t\r]/;

/** A plain number, which no spreadsheet parses as a formula. */
const PLAIN_NUMBER = /^-?\d+([.,]\d+)?$/;

/**
 * Defuse a cell a spreadsheet might execute.
 *
 * A customer whose surname is `=cmd|'/c calc'!A0` is not a hypothetical: it is the
 * standard CSV-injection payload, and the office exports customer names to a file
 * somebody opens by double-clicking. Prefixing an apostrophe makes Excel and
 * LibreOffice treat the cell as text, and the apostrophe itself is not displayed.
 *
 * **Well-formed numbers are exempt**, which the usual advice omits. `-4500` is how a
 * negative cash correction appears in the ledger, and no spreadsheet parses a bare
 * number as a formula — quoting it would turn every refund in the export into text a
 * bookkeeper cannot sum.
 */
export function neutralise(value: string): string {
  if (PLAIN_NUMBER.test(value)) return value;

  return FORMULA_LEAD.test(value) ? `'${value}` : value;
}

/**
 * One row, escaped and joined.
 *
 * Neutralisation happens here rather than at the call sites, so a new column cannot be
 * added without it. Quoting doubles embedded quotes, which is RFC 4180's escape and the
 * only one Excel understands.
 */
export function toCsvRow(cells: readonly (string | number | null | undefined)[]): string {
  return cells.map(toCsvCell).join(CSV_DELIMITER);
}

function toCsvCell(cell: string | number | null | undefined): string {
  if (cell === null || cell === undefined) return '';

  const value = neutralise(typeof cell === 'number' ? String(cell) : cell);

  return NEEDS_QUOTING.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

/** A row plus its terminator, which is what a stream actually pushes. */
export function csvLine(cells: readonly (string | number | null | undefined)[]): string {
  return toCsvRow(cells) + CSV_NEWLINE;
}

/**
 * Cents as a decimal string with a comma, which is what German Excel reads as a number.
 *
 * Formatted as a string rather than sent as a number, because a JSON number would have
 * to go through a locale-aware formatter somewhere and this is the only place that
 * knows the target is a German spreadsheet.
 */
export function csvAmount(amountCents: number): string {
  const sign = amountCents < 0 ? '-' : '';
  const absolute = Math.abs(amountCents);

  return `${sign}${String(Math.floor(absolute / 100))},${String(absolute % 100).padStart(2, '0')}`;
}

/** An instant as `YYYY-MM-DD HH:mm` in the organization's zone, for a human reader. */
export function csvInstant(instant: Date | null, zone: string): string {
  if (instant === null) return '';

  // `sv-SE` because its short format is already ISO-shaped; the zone is what matters.
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: zone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
    .format(instant)
    .replace(',', '');
}
