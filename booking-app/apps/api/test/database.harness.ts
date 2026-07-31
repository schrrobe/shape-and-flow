import { PrismaPg } from '@prisma/adapter-pg';

import { Prisma, PrismaClient } from '../src/prisma/client.js';

/**
 * A Prisma client bound to the integration-test database, plus a fast reset.
 *
 * Integration test files run sequentially (`fileParallelism: false` in
 * vitest.integration.config.ts) against one database, and every test truncates
 * first. This is a deliberate simplification of the plan's per-worker template
 * cloning: these tests exist to prove database guarantees, several deliberately
 * provoke lock contention, and a single deterministic database makes those
 * results unambiguous. If the suite ever gets slow enough to matter, per-worker
 * clones can be added behind this same interface without touching a test.
 */

const connectionString = process.env.DATABASE_URL;

if (!connectionString?.includes('booking_test')) {
  throw new Error(
    `Integration tests refuse to run against "${connectionString ?? '(unset)'}". ` +
      'The database name must contain "booking_test" — see vitest.integration.config.ts.',
  );
}

export const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString }),
});

let tableList: string | null = null;

/** Truncate every application table. Cheap enough to run before each test. */
export async function resetDatabase(): Promise<void> {
  if (tableList === null) {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>(Prisma.sql`
      SELECT tablename
      FROM pg_tables
      WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
    `);
    // Identifiers come from pg_tables, never from user input.
    tableList = rows.map((row) => `"${row.tablename}"`).join(', ');
  }

  if (tableList === '') return;

  await prisma.$executeRaw(
    Prisma.sql`TRUNCATE TABLE ${Prisma.raw(tableList)} RESTART IDENTITY CASCADE`,
  );
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
}

/** Reads a constraint definition, for tests that assert the schema itself. */
export async function constraintDefinition(name: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ def: string }[]>(Prisma.sql`
    SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = ${name}
  `);
  return rows[0]?.def ?? null;
}

/** True when an index exists, for tests that assert partial unique indexes. */
export async function indexExists(name: string): Promise<boolean> {
  const rows = await prisma.$queryRaw<{ count: bigint }[]>(Prisma.sql`
    SELECT count(*) AS count FROM pg_indexes WHERE schemaname = 'public' AND indexname = ${name}
  `);
  return Number(rows[0]?.count ?? 0) > 0;
}
