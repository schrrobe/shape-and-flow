import { describe, expect, it } from 'vitest';

import de from './de.json';
import en from './en.json';

interface Tree {
  [key: string]: string | Tree;
}

function flatten(tree: Tree, prefix = ''): string[] {
  return Object.entries(tree).flatMap(([key, value]) =>
    typeof value === 'string' ? [`${prefix}${key}`] : flatten(value, `${prefix}${key}.`),
  );
}

function valueAt(tree: Tree, path: string): string {
  const value = path.split('.').reduce<string | Tree | undefined>((node, key) => {
    if (node === undefined || typeof node === 'string') return undefined;
    return node[key];
  }, tree);

  if (typeof value !== 'string') throw new Error(`${path} is not a string`);
  return value;
}

/** `{name}` style placeholders, which vue-i18n interpolates. */
function placeholders(value: string): string[] {
  return [...value.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').sort();
}

const german = de as Tree;
const english = en as Tree;

describe('office translations', () => {
  it('have identical key sets', () => {
    // A key in one file and not the other is a screen that silently falls back to German for
    // an English reader, which looks like a bug in the copy rather than a missing translation.
    expect(flatten(german).sort()).toEqual(flatten(english).sort());
  });

  it('have no empty value', () => {
    for (const [tree, name] of [
      [german, 'de'],
      [english, 'en'],
    ] as const) {
      for (const key of flatten(tree))
        expect(valueAt(tree, key).trim(), `${name}:${key}`).not.toBe('');
    }
  });

  it('uses the same interpolation placeholders in both locales', () => {
    // A translation that drops `{amount}` shows a sentence with a hole in it, and one that
    // invents `{sum}` shows the placeholder verbatim.
    for (const key of flatten(german)) {
      expect(placeholders(valueAt(english, key)), key).toEqual(placeholders(valueAt(german, key)));
    }
  });

  it('keeps German and English genuinely different, so nothing was copied as a stub', () => {
    const identical = flatten(german).filter(
      (key) => valueAt(german, key) === valueAt(english, key),
    );

    // A handful legitimately match — proper nouns and the like. A large overlap means somebody
    // duplicated the German file to satisfy the key-parity test.
    expect(identical.length).toBeLessThan(flatten(german).length / 10);
  });
});
