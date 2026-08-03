-- Audit actions for the configuration surface built in Task 8.4.
--
-- Additive only: `ALTER TYPE ... ADD VALUE` is safe inside the transaction Prisma wraps
-- a migration in, provided the new values are not *used* in the same transaction —
-- which nothing here does. No constraint predicate references AuditAction, so unlike
-- BookingStatus (see 20260731210500_calendar_constraints) this needs no rebuild.

ALTER TYPE "AuditAction" ADD VALUE 'WORKING_HOURS_REPLACED';
ALTER TYPE "AuditAction" ADD VALUE 'EMPLOYEE_SERVICES_REPLACED';
ALTER TYPE "AuditAction" ADD VALUE 'AVAILABILITY_EXCEPTION_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'AVAILABILITY_EXCEPTION_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'TIME_OFF_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'TIME_OFF_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'BLOCKED_TIME_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'BLOCKED_TIME_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'CLOSED_DAY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'CLOSED_DAY_DELETED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_CATEGORY_CREATED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_CATEGORY_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'SERVICE_CATEGORY_ARCHIVED';
