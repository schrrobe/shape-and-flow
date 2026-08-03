-- Drop the redundant non-unique index; the unique index has the same prefix.
DROP INDEX "closed_days_organization_id_date_idx";

-- Preserve expiry timestamps after a booking leaves its reserving states.
ALTER TABLE "bookings"
  DROP CONSTRAINT "bookings_expires_at_matches_status",
  ADD CONSTRAINT "bookings_expires_at_matches_status"
    CHECK (status NOT IN ('PENDING_PAYMENT', 'EXPIRING') OR expires_at IS NOT NULL);

-- Employee-specific prices are configuration, not compensating ledger entries.
ALTER TABLE "employee_services"
  ADD CONSTRAINT "employee_services_price_override_check"
    CHECK (price_override_cents IS NULL OR price_override_cents >= 0);

-- Composite target keys let every booking relation enforce tenant ownership.
CREATE UNIQUE INDEX "employees_organization_id_id_key"
  ON "employees"("organization_id", "id");
CREATE UNIQUE INDEX "services_organization_id_id_key"
  ON "services"("organization_id", "id");
CREATE UNIQUE INDEX "customers_organization_id_id_key"
  ON "customers"("organization_id", "id");
CREATE UNIQUE INDEX "bookings_organization_id_id_key"
  ON "bookings"("organization_id", "id");

DROP INDEX "bookings_rescheduled_from_booking_id_key";
CREATE UNIQUE INDEX "bookings_organization_id_rescheduled_from_booking_id_key"
  ON "bookings"("organization_id", "rescheduled_from_booking_id");

ALTER TABLE "bookings"
  DROP CONSTRAINT "bookings_customer_id_fkey",
  DROP CONSTRAINT "bookings_employee_id_fkey",
  DROP CONSTRAINT "bookings_service_id_fkey",
  DROP CONSTRAINT "bookings_rescheduled_from_booking_id_fkey";

ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_organization_id_customer_id_fkey"
    FOREIGN KEY ("organization_id", "customer_id")
    REFERENCES "customers"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "bookings_organization_id_employee_id_fkey"
    FOREIGN KEY ("organization_id", "employee_id")
    REFERENCES "employees"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "bookings_organization_id_service_id_fkey"
    FOREIGN KEY ("organization_id", "service_id")
    REFERENCES "services"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "bookings_organization_id_rescheduled_from_booking_id_fkey"
    FOREIGN KEY ("organization_id", "rescheduled_from_booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- Booking-owned records must point to a booking from the same organization.
ALTER TABLE "booking_status_history"
  DROP CONSTRAINT "booking_status_history_booking_id_fkey",
  ADD CONSTRAINT "booking_status_history_organization_id_booking_id_fkey"
    FOREIGN KEY ("organization_id", "booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "management_tokens"
  DROP CONSTRAINT "management_tokens_booking_id_fkey",
  ADD CONSTRAINT "management_tokens_organization_id_booking_id_fkey"
    FOREIGN KEY ("organization_id", "booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "payments"
  DROP CONSTRAINT "payments_booking_id_fkey",
  ADD CONSTRAINT "payments_organization_id_booking_id_fkey"
    FOREIGN KEY ("organization_id", "booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "manual_payments"
  DROP CONSTRAINT "manual_payments_booking_id_fkey",
  ADD CONSTRAINT "manual_payments_organization_id_booking_id_fkey"
    FOREIGN KEY ("organization_id", "booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "refunds"
  DROP CONSTRAINT "refunds_booking_id_fkey",
  ADD CONSTRAINT "refunds_organization_id_booking_id_fkey"
    FOREIGN KEY ("organization_id", "booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "cancellation_requests"
  DROP CONSTRAINT "cancellation_requests_booking_id_fkey",
  ADD CONSTRAINT "cancellation_requests_organization_id_booking_id_fkey"
    FOREIGN KEY ("organization_id", "booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "reschedule_requests"
  DROP CONSTRAINT "reschedule_requests_booking_id_fkey",
  DROP CONSTRAINT "reschedule_requests_resulting_booking_id_fkey",
  ADD CONSTRAINT "reschedule_requests_organization_id_booking_id_fkey"
    FOREIGN KEY ("organization_id", "booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  ADD CONSTRAINT "reschedule_requests_organization_id_resulting_booking_id_fkey"
    FOREIGN KEY ("organization_id", "resulting_booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

DROP INDEX "reschedule_requests_resulting_booking_id_key";
CREATE UNIQUE INDEX "reschedule_requests_organization_id_resulting_booking_id_key"
  ON "reschedule_requests"("organization_id", "resulting_booking_id");

ALTER TABLE "notifications"
  DROP CONSTRAINT "notifications_booking_id_fkey",
  ADD CONSTRAINT "notifications_organization_id_booking_id_fkey"
    FOREIGN KEY ("organization_id", "booking_id")
    REFERENCES "bookings"("organization_id", "id")
    ON DELETE CASCADE ON UPDATE CASCADE;

-- Keep tenant scope first in the supporting booking-child indexes.
DROP INDEX "booking_status_history_booking_id_created_at_idx";
CREATE INDEX "booking_status_history_organization_id_booking_id_created_a_idx"
  ON "booking_status_history"("organization_id", "booking_id", "created_at");

DROP INDEX "management_tokens_booking_id_revoked_at_idx";
CREATE INDEX "management_tokens_organization_id_booking_id_revoked_at_idx"
  ON "management_tokens"("organization_id", "booking_id", "revoked_at");

DROP INDEX "payments_booking_id_idx";
CREATE INDEX "payments_organization_id_booking_id_idx"
  ON "payments"("organization_id", "booking_id");

DROP INDEX "manual_payments_booking_id_idx";
CREATE INDEX "manual_payments_organization_id_booking_id_idx"
  ON "manual_payments"("organization_id", "booking_id");

CREATE INDEX "refunds_organization_id_booking_id_idx"
  ON "refunds"("organization_id", "booking_id");
CREATE INDEX "cancellation_requests_organization_id_booking_id_idx"
  ON "cancellation_requests"("organization_id", "booking_id");
CREATE INDEX "reschedule_requests_organization_id_booking_id_idx"
  ON "reschedule_requests"("organization_id", "booking_id");

DROP INDEX "notifications_booking_id_idx";
CREATE INDEX "notifications_organization_id_booking_id_idx"
  ON "notifications"("organization_id", "booking_id");
