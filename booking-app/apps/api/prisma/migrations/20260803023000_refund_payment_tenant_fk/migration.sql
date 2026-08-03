-- Refunds must reference a payment owned by the same organization. This is a
-- forward migration so the preceding review-hardening migration stays immutable.
CREATE UNIQUE INDEX "payments_organization_id_id_key"
  ON "payments"("organization_id", "id");

ALTER TABLE "refunds"
  DROP CONSTRAINT "refunds_payment_id_fkey",
  ADD CONSTRAINT "refunds_organization_id_payment_id_fkey"
    FOREIGN KEY ("organization_id", "payment_id")
    REFERENCES "payments"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "refunds_payment_id_idx";
CREATE INDEX "refunds_organization_id_payment_id_idx"
  ON "refunds"("organization_id", "payment_id");
