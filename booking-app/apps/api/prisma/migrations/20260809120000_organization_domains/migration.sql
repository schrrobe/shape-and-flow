-- Domain-based tenant resolution for the public booking flow.
--
-- Until now the tenant for `/api/public/*` came only from `?organizer=<slug>`. This
-- table lets a request be resolved from the hostname it arrived on, so an organizer
-- can run the booking flow under its own domain with no query parameter at all.

-- CreateTable
CREATE TABLE "organization_domains" (
    "id" TEXT NOT NULL,
    "hostname" TEXT NOT NULL,
    "organization_id" TEXT NOT NULL,
    "is_primary" BOOLEAN NOT NULL DEFAULT false,
    "verified_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organization_domains_pkey" PRIMARY KEY ("id")
);

-- Globally unique, not unique per organization: this is what makes "one hostname
-- pointed at two organizations" unrepresentable rather than a race the resolver would
-- have to break arbitrarily. It is also the index every public request looks the
-- hostname up on.
-- CreateIndex
CREATE UNIQUE INDEX "organization_domains_hostname_key" ON "organization_domains"("hostname");

-- CreateIndex
CREATE INDEX "organization_domains_organization_id_idx" ON "organization_domains"("organization_id");

-- At most one primary domain per organization. Expressed as a partial unique index
-- because Prisma cannot declare one: a plain `@@unique([organizationId, isPrimary])`
-- would also forbid an organization from having two non-primary domains, which is the
-- normal case (`studio-muster.de` plus `www.studio-muster.de`).
CREATE UNIQUE INDEX "organization_domains_primary_key"
    ON "organization_domains"("organization_id")
    WHERE "is_primary";

-- AddForeignKey
ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Adding or removing a domain changes who the public booking flow answers as, so both
-- are audited. `ALTER TYPE ... ADD VALUE` is safe inside the transaction Prisma wraps a
-- migration in as long as the new values are not *used* in the same transaction, and
-- nothing here uses them. No constraint predicate references AuditAction, so unlike
-- BookingStatus (see 20260731210500_calendar_constraints) this needs no rebuild.
ALTER TYPE "AuditAction" ADD VALUE 'ORGANIZATION_DOMAIN_ADDED';
ALTER TYPE "AuditAction" ADD VALUE 'ORGANIZATION_DOMAIN_REMOVED';
