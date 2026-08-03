import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import { router } from '../router/index.js';

const SOURCE = resolve(process.cwd(), 'src');

/** The three places office code lives. */
const OFFICE_DIRECTORIES = ['/pages/office/', '/components/office/', '/src/office/'];

function sourceFiles(root: string): string[] {
  const found: string[] = [];

  for (const entry of readdirSync(root)) {
    const path = join(root, entry);

    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (/\.(ts|vue)$/.test(entry) && !entry.endsWith('.spec.ts')) found.push(path);
  }

  return found;
}

const isOffice = (file: string): boolean =>
  OFFICE_DIRECTORIES.some((directory) => file.includes(directory));

describe('office code stays out of the customer download', () => {
  it('is reached only through lazy route imports', () => {
    const officeRoutes = router
      .getRoutes()
      .filter((route) => route.path === '/office' || route.path.startsWith('/office/'));

    // Something has to be checked, or a renamed path would make this pass on an empty list.
    expect(officeRoutes.length).toBeGreaterThan(3);

    for (const route of officeRoutes) {
      const component = route.components?.default;

      // A function is a dynamic `import()`; an object is a component that was imported
      // statically, which welds the office area into whichever chunk the router is in.
      expect(typeof component, route.path).toBe('function');
    }
  });

  it('is imported by nothing on the customer side', () => {
    const offenders = sourceFiles(SOURCE)
      .filter((file) => !isOffice(file))
      .filter((file) => {
        const source = readFileSync(file, 'utf8');
        const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1] ?? '');

        // The router is allowed to name them, because it does so inside `() => import(...)`,
        // which is the whole mechanism that keeps them out of the entry chunk.
        const lazy = file.endsWith('router/index.ts');

        return imports.some((target) => /(pages|components)\/office\//.test(target)) && !lazy;
      });

    // A single static import from a customer page is enough to pull every office screen into
    // the bundle a customer downloads to book an appointment.
    expect(offenders).toEqual([]);
  });
});
