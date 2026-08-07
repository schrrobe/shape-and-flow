import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/** Everything Vue renders, so a hard-coded sentence anywhere is caught. */
function vueFiles(root: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) found.push(...vueFiles(path));
    else if (entry.endsWith('.vue')) found.push(path);
  }

  return found;
}

/** Only the template half: a sentence in a comment or a type is not rendered. */
function templatePart(source: string): string {
  const start = source.indexOf('<template>');
  return start === -1 ? '' : source.slice(start);
}

/**
 * Text nodes holding two or more words.
 *
 * One word is usually a brand name or a unit; two words in a row is a sentence somebody wrote
 * in one language and nobody translated. Comments are stripped because they carry the
 * reasoning, and mustaches because anything interpolated is by definition not a literal.
 */
export function literalSentences(source: string): string[] {
  const text = templatePart(source)
    .replaceAll(/<!--[\s\S]*?-->/g, ' ')
    .replaceAll(/\{\{[\s\S]*?\}\}/g, ' ')
    // Quote-aware: a `>` inside a quoted attribute value (`v-if="x > 0"`) is not a tag close,
    // and treating it as one leaves the attribute's tail dangling as fake template text.
    .replaceAll(/<(?:[^>"']|"[^"]*"|'[^']*')*>/g, '\0');

  return text
    .split('\0')
    .map((node) => node.replaceAll(/\s+/g, ' ').trim())
    .filter((node) => /[A-Za-zÄÖÜäöüß]{2,} [A-Za-zÄÖÜäöüß]{3,}/.test(node));
}

const SOURCE = resolve(process.cwd(), 'src');

/**
 * Text that is the same in every language.
 *
 * The business name is a proper noun: translating it would be wrong, and routing it through
 * `t()` would invite somebody to. Kept as a short explicit list rather than a loose heuristic,
 * so adding to it is a visible decision.
 */
const NOT_COPY = ['Shape and Flow'];

describe('app copy', () => {
  it('is never a literal sentence in a template', () => {
    const offenders = vueFiles(SOURCE)
      .map((file) => ({
        file,
        sentences: literalSentences(readFileSync(file, 'utf8')).filter(
          (sentence) => !NOT_COPY.includes(sentence),
        ),
      }))
      .filter((entry) => entry.sentences.length > 0)
      .map((entry) => `${entry.file}: ${entry.sentences.join(' | ')}`);

    // A German sentence baked into a template is a sentence an English reader will also see,
    // and no key-parity test can find it. Covers the office area too: its copy lives in
    // src/office/i18n/{en,de}.json, merged into the shared i18n instance lazily so it never
    // reaches the customer bundle — see src/office/i18n/index.ts.
    expect(offenders).toEqual([]);
  });

  it('catches a literal when one is introduced', () => {
    // Proves the detector is not vacuous: without this, an over-eager change to the regex would
    // make the test above pass on everything.
    expect(literalSentences('<template><p>Termin wurde gebucht</p></template>')).toEqual([
      'Termin wurde gebucht',
    ]);
  });

  it('does not flag interpolated copy', () => {
    expect(literalSentences('<template><p>{{ t("booking.title") }}</p></template>')).toEqual([]);
  });

  it('does not flag a `>` inside a quoted attribute expression', () => {
    expect(literalSentences('<template><p v-if="amount > 0">{{ amount }}</p></template>')).toEqual(
      [],
    );
  });
});
