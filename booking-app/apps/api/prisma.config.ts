import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { config as loadDotenv } from 'dotenv';
import { defineConfig } from 'prisma/config';

// The Prisma CLI runs with this package as its working directory, but the
// environment file belongs to the product area one level up, so resolve it
// relative to this file rather than to cwd.
const packageDir = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(packageDir, '../../.env'), quiet: true });

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error('DATABASE_URL is not set. Copy booking-app/.env.example to booking-app/.env.');
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
    url: databaseUrl,
  },
});
