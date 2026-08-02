import { Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';

import { GlobalExceptionFilter } from '../src/common/errors/global-exception.filter.js';
import { AuthGuard } from '../src/common/guards/auth.guard.js';
import { CLOCK, FixedClock } from '../src/domain/time/clock.js';
import { OrganizationContextService } from '../src/organization/organization-context.service.js';
import { PrismaService } from '../src/prisma/prisma.service.js';

import { prisma } from './database.harness.js';

import type { OrganizationWithSettings } from '../src/organization/organization-context.service.js';
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';

/**
 * A Nest application over the test database, wired the way the real one is.
 *
 * Two things are substituted, and only two. The organization context is a stub,
 * because the real one resolves its slug from the validated environment at bootstrap
 * and standing up the whole config stack to test a slot calculation would prove
 * nothing extra. The clock is fixed, because availability depends on "now" three ways
 * — minimum notice, the booking horizon, and the clamp to today — and a suite whose
 * answers change with the wall clock is not a suite.
 *
 * Everything else is the real thing: the real controllers, the real error filter, and
 * the real global AuthGuard, so "closed by default" is exercised over HTTP rather
 * than asserted about a class in isolation.
 *
 * ThrottlerGuard is deliberately absent. It needs Redis, and no test here is about
 * rate limits; `@Throttle` is inert as a result, which is worth knowing when reading
 * a passing suite.
 */

/** Counts Prisma operations, so a test can assert an N+1 has not appeared. */
export interface QueryCounter {
  reset: () => void;
  total: () => number;
}

let queryCount = 0;

export const queryCounter: QueryCounter = {
  reset: () => {
    queryCount = 0;
  },
  total: () => queryCount,
};

/**
 * The client the application under test uses.
 *
 * It counts Prisma *operations*, not SQL statements — a nested include is one
 * operation and may be more than one statement. That is the right granularity for
 * what these tests assert: an N+1 appears as an operation per day or per employee.
 */
export const countingPrisma = (prisma as unknown as PrismaService).$extends({
  query: {
    $allModels: {
      $allOperations({ args, query }) {
        queryCount += 1;
        return query(args);
      },
    },
  },
}) as unknown as PrismaService;

/** Mutable so the harness module, built once, always sees the current test's data. */
let currentOrganization: OrganizationWithSettings | null = null;
let currentNow: Date | null = null;

function organizationStub(): Partial<OrganizationContextService> {
  const read = (): OrganizationWithSettings => {
    if (currentOrganization === null) {
      throw new Error('Organization not set. Call createPublicTestApp from a beforeEach.');
    }
    return currentOrganization;
  };

  return {
    get: read,
    getOrganizationId: () => read().id,
    getSettings: () => read().settings,
    getTimezone: () => read().timezone,
  };
}

@Global()
@Module({
  providers: [
    { provide: PrismaService, useValue: countingPrisma },
    { provide: CLOCK, useFactory: () => new FixedClock(currentNow ?? new Date()) },
    { provide: OrganizationContextService, useFactory: organizationStub },
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
  exports: [PrismaService, CLOCK, OrganizationContextService],
})
// A Nest module is a declaration carrier with an empty body by design. The shared
// ESLint config exempts `*.module.ts`; this one is a harness, not a module file.
// eslint-disable-next-line @typescript-eslint/no-extraneous-class
class PublicTestHarnessModule {}

export interface TestApp {
  app: INestApplication;
  server: () => Server;
  close: () => Promise<void>;
}

/** Build and initialise an application containing `imports`. */
export async function createPublicTestApp(options: {
  organization: OrganizationWithSettings;
  now: Date;
  imports: NonNullable<Parameters<typeof Test.createTestingModule>[0]['imports']>;
}): Promise<TestApp> {
  currentOrganization = options.organization;
  currentNow = options.now;

  const moduleRef = await Test.createTestingModule({
    imports: [PublicTestHarnessModule, ...options.imports],
  }).compile();

  const app = moduleRef.createNestApplication();
  await app.init();

  return {
    app,
    server: () => app.getHttpServer() as Server,
    close: async () => {
      await app.close();
    },
  };
}

/** Load the seeded organization in the shape the context service exposes. */
export async function loadOrganization(organizationId: string): Promise<OrganizationWithSettings> {
  return (await prisma.organization.findUniqueOrThrow({
    where: { id: organizationId },
    include: { settings: true },
  })) as OrganizationWithSettings;
}
