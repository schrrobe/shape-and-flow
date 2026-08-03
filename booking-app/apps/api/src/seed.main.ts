import { randomBytes } from 'node:crypto';

import { PrismaPg } from '@prisma/adapter-pg';

import { loadEnvFile } from './config/load-dotenv.js';
import { seedDemoOrganization } from './organization/demo-seed.js';
import { PrismaClient } from './prisma/client.js';

/**
 * Seeds one demonstrable business, and says what it created.
 *
 * The seeding itself lives in `src/organization/demo-seed.ts`, because the
 * end-to-end suite reseeds between tests through the test-support router and both
 * must produce the same business. This file is the command-line half: a client, a
 * generated password, and the summary.
 *
 * An entrypoint under `src` rather than a script under `prisma`, so `nest build`
 * compiles it: the end-to-end stack runs `node dist/seed.main.js` before the API,
 * because the API refuses to start against a database with no organization in it,
 * and a deployment needs the same command for the same reason on its first boot.
 *
 * Run locally with `pnpm db:seed`, which invokes tsx directly rather than going
 * through `prisma db seed`. The CLI wrapper adds nothing here — the seed needs no
 * Prisma CLI service — and it was observed hanging after the child had already
 * exited successfully. prisma.config.ts still declares the seed command so
 * `prisma migrate reset` keeps working.
 */

loadEnvFile();

const connectionString = process.env.DATABASE_URL;
if (!connectionString) {
  throw new Error('DATABASE_URL is not set. Copy booking-app/.env.example to booking-app/.env.');
}

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

// Generated and printed once rather than hard-coded, so a seeded database is not a
// known-credentials database. The e2e stack sets both explicitly instead.
const generated = (): string => randomBytes(12).toString('base64url');

try {
  const ownerPassword = process.env.SEED_OWNER_PASSWORD ?? generated();
  const staffPassword = process.env.SEED_STAFF_PASSWORD ?? generated();

  const result = await seedDemoOrganization(prisma, { ownerPassword, staffPassword });

  const credential = (email: string, password: string, wasSet: boolean): string =>
    wasSet
      ? `${email} / ${password}   <- shown once, change it after first login`
      : `${email} / (unchanged — the user already existed)`;

  const lines = [
    '',
    `Seeded organization : Shape and Flow (${result.slug})`,
    `Employees           : ${String(result.employeeCount)}`,
    `Services            : ${String(result.serviceCount)}`,
    `Closed days         : ${String(result.closedDayCount)}`,
    `Owner login         : ${credential(result.ownerEmail, ownerPassword, result.ownerPasswordWasSet)}`,
    `Staff login         : ${credential(result.staffEmail, staffPassword, result.staffPasswordWasSet)}`,
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
} finally {
  await prisma.$disconnect();
}
