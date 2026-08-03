import { describe, expect, it } from 'vitest';

import { CSV_BOM, csvAmount, csvInstant, csvLine, neutralise, toCsvRow } from './csv.js';

describe('toCsvRow', () => {
  it('quotes and escapes embedded delimiters, quotes and newlines', () => {
    expect(toCsvRow(['a;b', 'c"d', 'e\nf'])).toBe('"a;b";"c""d";"e\nf"');
  });

  it('leaves a plain cell alone', () => {
    expect(toCsvRow(['Anna', 'Becker', 'SF-ABC123'])).toBe('Anna;Becker;SF-ABC123');
  });

  it('writes an empty cell for null and undefined', () => {
    // Distinguishing "no value" from the string "null" matters to whoever reads the
    // file: one is a blank cell, the other is data.
    expect(toCsvRow(['a', null, undefined, 'b'])).toBe('a;;;b');
  });

  it('renders a number without quoting it', () => {
    expect(toCsvRow([42, -7])).toBe('42;-7');
  });
});

describe('neutralise', () => {
  it('defuses every character a spreadsheet may read as a formula', () => {
    expect(neutralise('=cmd|calc')).toBe("'=cmd|calc");
    expect(neutralise('+1+1')).toBe("'+1+1");
    expect(neutralise('@SUM(A1)')).toBe("'@SUM(A1)");
    expect(neutralise('-cmd')).toBe("'-cmd");
    expect(neutralise('\tinjected')).toBe("'\tinjected");
  });

  it('leaves a well-formed number alone, including a negative one', () => {
    // A negative cash correction is `-45,00` in the ledger. Quoting it would turn every
    // refund in the export into text nobody can sum, and no spreadsheet parses a bare
    // number as a formula.
    expect(neutralise('-4500')).toBe('-4500');
    expect(neutralise('-45,00')).toBe('-45,00');
    expect(neutralise('45.00')).toBe('45.00');
  });

  it('leaves ordinary text alone', () => {
    expect(neutralise('Anna Becker')).toBe('Anna Becker');
  });

  it('is applied by toCsvRow, so a column cannot be added without it', () => {
    expect(toCsvRow(['=cmd|calc'])).toBe("'=cmd|calc");
  });
});

describe('csvLine', () => {
  it('terminates with CRLF, which is what RFC 4180 and Excel expect', () => {
    expect(csvLine(['a', 'b'])).toBe('a;b\r\n');
  });
});

describe('CSV_BOM', () => {
  it('is the single character Excel looks for to read the file as UTF-8', () => {
    // Without it every umlaut in a customer name arrives as two characters.
    expect(CSV_BOM).toHaveLength(1);
    expect(CSV_BOM.charCodeAt(0)).toBe(0xfeff);
  });
});

describe('csvAmount', () => {
  it('writes cents as a German decimal', () => {
    expect(csvAmount(4500)).toBe('45,00');
    expect(csvAmount(4505)).toBe('45,05');
    expect(csvAmount(5)).toBe('0,05');
    expect(csvAmount(0)).toBe('0,00');
  });

  it('keeps the sign in front, where a reader expects it', () => {
    expect(csvAmount(-4500)).toBe('-45,00');
    expect(csvAmount(-5)).toBe('-0,05');
  });
});

describe('csvInstant', () => {
  it('renders in the organization zone, not UTC', () => {
    // 2026-08-14T20:00Z is 22:00 in Berlin. A UTC rendering would put every evening
    // appointment on the wrong line of the day for whoever reads the file.
    expect(csvInstant(new Date('2026-08-14T20:00:00.000Z'), 'Europe/Berlin')).toBe(
      '2026-08-14 22:00',
    );
  });

  it('crosses the date boundary correctly', () => {
    expect(csvInstant(new Date('2026-08-14T22:30:00.000Z'), 'Europe/Berlin')).toBe(
      '2026-08-15 00:30',
    );
  });

  it('renders an absent instant as an empty cell', () => {
    expect(csvInstant(null, 'Europe/Berlin')).toBe('');
  });
});
