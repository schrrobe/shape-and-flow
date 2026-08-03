-- Audit actions for the customer surface built in Task 8.5.
--
-- Additive only; see 20260801190000_audit_actions_for_configuration for why adding an
-- AuditAction value is safe inside Prisma's migration transaction.
--
-- CUSTOMER_ERASED is the one audit row that has to outlive its subject. Erasure
-- pseudonymises the customer, so the log entry is the only remaining evidence that the
-- request was made and honoured.

ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_UPDATED';
ALTER TYPE "AuditAction" ADD VALUE 'CUSTOMER_ERASED';
