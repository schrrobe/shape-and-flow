import { AppError } from '../common/errors/app-error.js';

import { Prisma } from './client.js';

import type { PrismaClient } from './client.js';

/**
 * Makes an unscoped query a loud failure instead of a silent cross-tenant leak.
 *
 * Phase 1 runs a single organization, so nothing here is load-bearing *today*.
 * That is exactly why it belongs here now: the day a second organization exists,
 * every query written in the meantime is already scoped, and the ones that are
 * not have been failing tests since they were written.
 *
 * Three layers enforce the same invariant. This is the second; the first is a
 * contract test asserting no request schema accepts an organizationId, and the
 * third is integration tests that seed two organizations and assert isolation
 * through the HTTP surface.
 */

/**
 * Models whose `organizationId` is NOT NULL, and which therefore must never be
 * queried without it.
 *
 * Prisma 7 no longer exposes `Prisma.dmmf`, so this cannot be derived at
 * runtime. It is instead cross-checked against schema.prisma by
 * tenant.extension.spec.ts, which fails if a model gains or loses a required
 * organizationId without this list changing — so the set cannot drift.
 *
 * Deliberately excluded:
 *  - Organization, which is the tenant root.
 *  - IdempotencyKey, StripeWebhookEvent and MessagingWebhookEvent, whose
 *    organizationId is nullable because the row is written before the tenant is
 *    known. They are addressed by their own unique provider keys, and the
 *    reconcilers legitimately scan them globally.
 */
export const ORG_SCOPED_MODELS: readonly Prisma.ModelName[] = [
  'OrganizationSettings',
  'OrganizationDomain',
  'ClosedDay',
  'OfficeUser',
  'PasswordResetToken',
  'Employee',
  'WorkingHours',
  'Break',
  'AvailabilityException',
  'TimeOff',
  'BlockedTime',
  'ServiceCategory',
  'Service',
  'EmployeeService',
  'Customer',
  'Booking',
  'BookingStatusHistory',
  'ManagementToken',
  'Payment',
  'ManualPayment',
  'Refund',
  'CancellationRequest',
  'RescheduleRequest',
  'Notification',
  'OutboxEvent',
  'AuditLog',
];

const SCOPED = new Set<string>(ORG_SCOPED_MODELS);

/**
 * Operations that must carry organizationId in `where`.
 *
 * Unique reads use Prisma's extended unique filters: a unique selector (usually
 * `id`) plus `organizationId`. Upsert is handled separately below and must use
 * a tenant-bearing compound unique key.
 */
const GUARDED_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/** Operations that get organizationId injected when it is absent. */
const INJECTED_OPERATIONS = new Set(['create', 'createMany', 'createManyAndReturn']);

const NESTED_WRITE_OPERATIONS = new Set([
  'create',
  'createMany',
  'update',
  'updateMany',
  'upsert',
  'connectOrCreate',
  'connect',
  'disconnect',
  'set',
  'delete',
  'deleteMany',
]);

// These are scalar JSON columns, not Prisma relation fields. Their user data may
// legitimately contain keys such as `create` or `update`.
const JSON_FIELDS = new Set(['metadata', 'payload', 'responseSnapshot', 'before', 'after']);

type ScopeState = 'missing' | 'matching' | 'mismatching';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

function organizationIdState(value: unknown, organizationId: string): ScopeState {
  if (typeof value === 'string') return value === organizationId ? 'matching' : 'mismatching';

  if (!isRecord(value)) return 'mismatching';
  const keys = Object.keys(value);
  return keys.length === 1 && keys[0] === 'equals' && value.equals === organizationId
    ? 'matching'
    : 'mismatching';
}

function combineScopeStates(states: ScopeState[]): ScopeState {
  if (states.includes('matching')) return 'matching';
  if (states.includes('mismatching')) return 'mismatching';
  return 'missing';
}

/**
 * Classifies a normal filter. Only a direct equality or an equality inside a
 * top-level AND counts: accepting OR/NOT would make the tenant predicate
 * optional and reopen cross-tenant reads.
 */
function filterScopeState(where: unknown, organizationId: string): ScopeState {
  if (!isRecord(where)) return 'missing';
  if ('organizationId' in where) {
    return organizationIdState(where.organizationId, organizationId);
  }

  const and = where.AND;
  if (Array.isArray(and)) {
    return combineScopeStates(and.map((clause) => filterScopeState(clause, organizationId)));
  }
  return filterScopeState(and, organizationId);
}

/** Compound unique inputs wrap their fields in a generated key such as
 * `organizationId_name`, so upsert/update must inspect those wrappers too. */
const TENANT_COMPOUND_UNIQUE_KEYS = new Set([
  'organizationId_date',
  'organizationId_email',
  'organizationId_emailNormalized',
  'organizationId_id',
  'organizationId_name',
  'organizationId_reference',
  'organizationId_rescheduledFromBookingId',
  'organizationId_resultingBookingId',
]);

function uniqueScopeState(where: unknown, organizationId: string): ScopeState {
  const direct = filterScopeState(where, organizationId);
  if (direct !== 'missing' || !isRecord(where)) return direct;

  return combineScopeStates(
    Object.entries(where)
      .filter(([key]) => TENANT_COMPOUND_UNIQUE_KEYS.has(key))
      .map(([, value]) => uniqueScopeState(value, organizationId)),
  );
}

function throwUnscoped(model: string, operation: string): never {
  throw new AppError('UNSCOPED_TENANT_QUERY', {
    status: 500,
    message:
      `${model}.${operation} requires organizationId in its where clause. ` +
      'Scope the query, or use the raw PrismaService if this is deliberately global.',
    details: { model, operation },
  });
}

function throwTenantMismatch(model: string, operation: string): never {
  throw new AppError('TENANT_MISMATCH', {
    status: 500,
    message: `${model}.${operation} must use the current organizationId.`,
    details: { model, operation },
  });
}

function rejectNestedWrites(row: Record<string, unknown>, model: string, operation: string): void {
  for (const [field, value] of Object.entries(row)) {
    if (field === 'organization' || JSON_FIELDS.has(field) || !isRecord(value)) continue;
    if (Object.keys(value).some((key) => NESTED_WRITE_OPERATIONS.has(key))) {
      throw new AppError('UNSCOPED_TENANT_QUERY', {
        status: 500,
        message:
          `${model}.${operation} does not allow nested writes through the tenant client. ` +
          'Write the related model explicitly so its tenant guard runs.',
        details: { model, operation, field },
      });
    }
  }
}

function requireScope(
  model: string,
  operation: string,
  state: ScopeState,
): asserts state is 'matching' {
  if (state === 'missing') throwUnscoped(model, operation);
  if (state === 'mismatching') throwTenantMismatch(model, operation);
}

/**
 * Assert that a row addressed by unique key belongs to the expected
 * organization. Returns 404 rather than 403: a 403 confirms the id exists,
 * which is an enumeration oracle.
 */
export function assertOwned<T extends { organizationId: string }>(
  row: T | null,
  organizationId: string,
): T {
  if (row?.organizationId !== organizationId) {
    throw new AppError('NOT_FOUND', { status: 404, message: 'Resource not found.' });
  }
  return row;
}

function validateOrganizationRelation(
  row: Record<string, unknown>,
  organizationId: string,
  model: string,
  operation: string,
): boolean {
  if (!('organization' in row)) return false;
  const relation = row.organization;
  const connectedId = isRecord(relation) && isRecord(relation.connect) ? relation.connect.id : null;
  if (connectedId !== organizationId) throwTenantMismatch(model, operation);
  return true;
}

function tenantCreateRow(
  row: unknown,
  organizationId: string,
  model: string,
  operation: string,
): unknown {
  if (!isRecord(row)) return row;
  rejectNestedWrites(row, model, operation);
  if ('organizationId' in row) {
    if (row.organizationId !== organizationId) throwTenantMismatch(model, operation);
    return row;
  }
  if (validateOrganizationRelation(row, organizationId, model, operation)) return row;
  return { ...row, organizationId };
}

function tenantCreateArgs(
  args: unknown,
  field: 'data' | 'create',
  organizationId: string,
  model: string,
  operation: string,
): unknown {
  if (!isRecord(args)) return args;
  const payload = args[field];
  const scoped = Array.isArray(payload)
    ? payload.map((row) => tenantCreateRow(row, organizationId, model, operation))
    : tenantCreateRow(payload, organizationId, model, operation);
  return { ...args, [field]: scoped };
}

function validateUpdatePayload(
  args: unknown,
  organizationId: string,
  model: string,
  operation: string,
): void {
  if (!isRecord(args) || !isRecord(args.data)) return;
  rejectNestedWrites(args.data, model, operation);
  if ('organization' in args.data) throwTenantMismatch(model, operation);
  if ('organizationId' in args.data && args.data.organizationId !== organizationId) {
    throwTenantMismatch(model, operation);
  }
}

function tenantGuardExtension(getOrganizationId: () => string) {
  return Prisma.defineExtension({
    name: 'tenant-guard',
    query: {
      $allModels: {
        $allOperations({ model, operation, args, query }) {
          if (!SCOPED.has(model)) return query(args);

          const organizationId = getOrganizationId();

          if (operation === 'upsert') {
            const { where } = args as { where?: unknown };
            requireScope(model, operation, uniqueScopeState(where, organizationId));
            validateUpdatePayload(
              { data: (args as { update?: unknown }).update },
              organizationId,
              model,
              operation,
            );
            return query(
              tenantCreateArgs(args, 'create', organizationId, model, operation) as typeof args,
            );
          }

          if (INJECTED_OPERATIONS.has(operation)) {
            return query(
              tenantCreateArgs(args, 'data', organizationId, model, operation) as typeof args,
            );
          }

          if (GUARDED_OPERATIONS.has(operation)) {
            const { where } = args as { where?: unknown };
            const scopeState =
              operation === 'update' ||
              operation === 'delete' ||
              operation === 'findUnique' ||
              operation === 'findUniqueOrThrow'
                ? uniqueScopeState(where, organizationId)
                : filterScopeState(where, organizationId);
            requireScope(model, operation, scopeState);
            if (operation.startsWith('update')) {
              validateUpdatePayload(args, organizationId, model, operation);
            }
          }

          return query(args);
        },
      },
    },
  });
}

/**
 * The tenant-guarded client every service should depend on.
 *
 * Typed as PrismaClient rather than as the extension's own return type. That is
 * accurate — a query extension intercepts calls but adds no model, field or
 * method, so the surface really is PrismaClient — and it matters in practice:
 * `$extends` produces a type built from unions of every argument shape for every
 * model, and propagating it made type-aware linting of this package take over ten
 * minutes.
 */
export type TenantPrismaClient = PrismaClient;

/** Injection token for the guarded client. */
export const TENANT_PRISMA = 'TENANT_PRISMA';

/** Wrap a client so tenant scoping is enforced. */
export function createTenantGuardedClient(
  client: PrismaClient,
  getOrganizationId: () => string,
): TenantPrismaClient {
  return client.$extends(tenantGuardExtension(getOrganizationId)) as unknown as TenantPrismaClient;
}
