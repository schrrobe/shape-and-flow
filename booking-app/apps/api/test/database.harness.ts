import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';

import { assertTestDatabaseUrl } from '../src/config/env.schema.js';
import { Prisma, PrismaClient } from '../src/prisma/client.js';
import { createTenantGuardedClient } from '../src/prisma/tenant.extension.js';

import type { TenantPrismaClient } from '../src/prisma/tenant.extension.js';

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

const connectionString = assertTestDatabaseUrl(process.env.DATABASE_URL);

/**
 * The pool is created here rather than letting the adapter own it, so teardown
 * can close it explicitly and deterministically instead of relying on
 * `$disconnect()` to release every socket.
 */
const pool = new pg.Pool({ connectionString, max: 10 });

export const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });

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

  // TRUNCATE needs ACCESS EXCLUSIVE on every table, so any other session with an
  // open transaction blocks it. Without a lock timeout that surfaces only as
  // "Hook timed out" thirty seconds later, which says nothing about the cause.
  // Five seconds and a real PostgreSQL lock-timeout error is far easier to act
  // on: it means a stray connection — usually a killed test run — is still
  // holding locks on booking_test.
  await prisma.$transaction([
    prisma.$executeRaw(Prisma.sql`SET LOCAL lock_timeout = '5s'`),
    prisma.$executeRaw(
      Prisma.sql`TRUNCATE TABLE ${Prisma.raw(tableList)} RESTART IDENTITY CASCADE`,
    ),
  ]);
}

export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  // Ends every idle client, so no socket keeps the event loop alive.
  await pool.end();
}

/** Reads a constraint definition, for tests that assert the schema itself. */
export async function constraintDefinition(name: string): Promise<string | null> {
  const rows = await prisma.$queryRaw<{ def: string }[]>(Prisma.sql`
    SELECT pg_get_constraintdef(pc.oid) AS def
    FROM pg_constraint AS pc
    JOIN pg_namespace AS namespace ON namespace.oid = pc.connamespace
    WHERE namespace.nspname = 'public' AND pc.conname = ${name}
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

/** A tenant-guarded client bound to one organization, for guard tests. */
export function guardedFor(organizationId: string): TenantPrismaClient {
  return createTenantGuardedClient(prisma, () => organizationId);
}
