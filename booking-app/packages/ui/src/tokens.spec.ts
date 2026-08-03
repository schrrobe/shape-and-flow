import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

/**
 * Paths from the package root, not from `import.meta.url`.
 *
 * Under a DOM environment Vitest serves modules over a virtual http URL, so
 * `new URL('./x', import.meta.url)` is not a file URL and `readFileSync` refuses it. Vitest
 * runs with the package directory as cwd, which is stable.
 */
const SRC = resolve(process.cwd(), 'src');

const tokensCss = readFileSync(join(SRC, 'tokens.css'), 'utf8');
const themeCss = readFileSync(join(SRC, 'theme.css'), 'utf8');

/** Every `--sf-*` custom property declared, mapped to its value. */
const declared = new Map(
  [...tokensCss.matchAll(/--sf-([a-z0-9-]+):\s*([^;]+);/g)].map((match) => [
    match[1] ?? '',
    (match[2] ?? '').trim(),
  ]),
);

/**
 * The tokens every screen is allowed to style against.
 *
 * A closed list on purpose: a component needing a colour that is not here is a design
 * decision, and it should be made in `tokens.css` where the contrast tests can see it.
 */
const SEMANTIC = [
  'background',
  'surface',
  'surface-muted',
  'text-primary',
  'text-secondary',
  'border',
  'primary',
  'primary-hover',
  'primary-contrast',
  'success',
  'warning',
  'danger',
  'focus-ring',
];

function tokenValue(name: string): string {
  const value = declared.get(name);
  if (value === undefined) throw new Error(`token --sf-${name} is not declared`);
  return value;
}

/** `#rrggbb` (or `#rgb`) to its three channels. */
function channels(hex: string): [number, number, number] {
  const clean = hex.replace('#', '');
  // A shorthand `#abc` expands to `#aabbcc`. Splitting by code point is safe because a hex
  // colour is ASCII by construction — the rule's emoji concern cannot apply.
  const full =
    clean.length === 3
      ? clean.replaceAll(/[0-9a-fA-F]/g, (character) => character.repeat(2))
      : clean.slice(0, 6);

  return [
    Number.parseInt(full.slice(0, 2), 16),
    Number.parseInt(full.slice(2, 4), 16),
    Number.parseInt(full.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance: sRGB channels, linearised, weighted. */
function luminance(hex: string): number {
  const [red, green, blue] = channels(hex).map((value) => {
    const channel = value / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];

  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Every source file in a directory tree, filtered by extension. */
function sourceFiles(root: string, extensions: string[]): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);

    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path, extensions));
      continue;
    }

    if (extensions.some((extension) => entry.endsWith(extension))) found.push(path);
  }

  return found;
}

describe('the contrast helper', () => {
  it('agrees with the two values everybody knows', () => {
    // Black on white is 21:1 and a colour against itself is 1:1. Without this, a broken
    // luminance formula would make every other assertion in this file pass vacuously.
    expect(contrast('#000000', '#ffffff')).toBeCloseTo(21, 1);
    expect(contrast('#c2540a', '#c2540a')).toBeCloseTo(1, 5);
  });
});

describe('design tokens', () => {
  it('declares every semantic token', () => {
    for (const name of SEMANTIC) expect([...declared.keys()], name).toContain(name);
  });

  it('maps every semantic token into the tailwind theme', () => {
    // The mapping is what makes `bg-surface` and `text-danger` exist. A token declared and
    // not mapped is a colour no component can reach.
    for (const name of SEMANTIC) {
      expect(themeCss, name).toContain(`--color-${name}: var(--sf-${name});`);
    }
  });

  it('maps nothing that is not declared', () => {
    const mapped = [...themeCss.matchAll(/var\(--sf-([a-z0-9-]+)\)/g)].map((match) => match[1]);

    for (const name of mapped) expect([...declared.keys()], name).toContain(name);
  });

  it('meets WCAG AA for body text and for buttons', () => {
    expect(contrast(tokenValue('text-primary'), tokenValue('background'))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(tokenValue('text-secondary'), tokenValue('background'))).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrast(tokenValue('text-primary'), tokenValue('surface'))).toBeGreaterThanOrEqual(4.5);
    expect(contrast(tokenValue('primary-contrast'), tokenValue('primary'))).toBeGreaterThanOrEqual(
      4.5,
    );
  });

  it('keeps the hover state readable too', () => {
    // A hover colour that fails contrast fails it exactly while somebody is pointing at the
    // thing they are about to click.
    expect(
      contrast(tokenValue('primary-contrast'), tokenValue('primary-hover')),
    ).toBeGreaterThanOrEqual(4.5);
  });

  it('meets WCAG AA large-text contrast on the status surfaces', () => {
    for (const name of ['success', 'warning', 'danger']) {
      expect(contrast(tokenValue('text-primary'), tokenValue(name)), name).toBeGreaterThanOrEqual(
        3,
      );
    }
  });

  it('keeps the focus ring visible on both the page and the primary button', () => {
    // 3:1 against adjacent colour is the WCAG requirement for a non-text indicator. An orange
    // ring on an orange button is the failure this guards.
    expect(contrast(tokenValue('focus-ring'), tokenValue('background'))).toBeGreaterThanOrEqual(3);
    expect(contrast(tokenValue('focus-ring'), tokenValue('primary'))).toBeGreaterThanOrEqual(3);
  });

  it('uses no raw hex colour outside tokens.css', () => {
    const offenders: string[] = [];

    for (const file of sourceFiles(SRC, ['.vue', '.ts', '.css'])) {
      if (file.endsWith('tokens.css') || file.endsWith('tokens.spec.ts')) continue;

      const matches = readFileSync(file, 'utf8').match(/#[0-9a-fA-F]{3,8}\b/g);
      if (matches !== null) offenders.push(`${file}: ${matches.join(', ')}`);
    }

    // One colour written twice is one colour that will be changed once.
    expect(offenders).toEqual([]);
  });
});
