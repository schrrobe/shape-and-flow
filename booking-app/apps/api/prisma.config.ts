import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The Prisma CLI runs with this package as its working directory, but the
// environment file belongs to the product area one level up, so resolve it
// relative to this file rather than to cwd.
const packageDir = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(packageDir, '../../.env'), quiet: true });

/**
 * `prisma generate` reads the schema and writes the client. It never opens a
 * connection, and it runs from `postinstall` — including on machines and CI
 * jobs that have no database at all. Demanding a URL there turns every install
 * into a failure. Every other command does talk to the database, so those keep
 * the pointed error.
 */
const generateOnly = process.argv.includes('generate');
const databaseUrl = process.env.DATABASE_URL;
if (databaseUrl === undefined && !generateOnly) {
  throw new Error('DATABASE_URL is not set. Copy booking-app/.env.example to booking-app/.env.');
}

// Never reached by a command that connects: the guard above rejects those.
const UNUSED_BY_GENERATE = 'postgresql://generate:generate@127.0.0.1:5432/generate?schema=public';

/**
 * A throwaway database for `migrate diff --from-migrations` and `migrate dev`.
 *
 * Derived from `DATABASE_URL` rather than configured separately, so the drift gate runs
 * with no extra setup and cannot point at the real database by mistake. Prisma 7 requires
 * this to be in the config: `--shadow-database-url` was removed from the CLI.
 */
function shadowDatabaseUrl(url: string): string {
  const parsed = new URL(url);
  parsed.pathname = `${parsed.pathname.replace(/\/$/, '')}_shadow`;
  return parsed.toString();
}

export default defineConfig({
  schema: resolve(packageDir, 'prisma/schema.prisma'),
  migrations: {
    path: resolve(packageDir, 'prisma/migrations'),
    // tsx, not bare node: the seed imports the generated Prisma client through
    // `../src/prisma/client.js`, and Node does not resolve a `.js` specifier to
    // the `.ts` file that actually exists. tsx applies the same NodeNext
    // resolution TypeScript does.
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    url: databaseUrl ?? UNUSED_BY_GENERATE,
    shadowDatabaseUrl:
      process.env.SHADOW_DATABASE_URL ?? shadowDatabaseUrl(databaseUrl ?? UNUSED_BY_GENERATE),
  },
});
