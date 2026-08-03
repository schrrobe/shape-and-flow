-- The booking the money is on, for every booking in a reschedule chain.
--
-- Backfilled by walking the existing `rescheduled_from_booking_id` links once, here,
-- rather than leaving the application to walk them on every read. Roots keep NULL:
-- "this booking is its own root" is the common case and storing it would be a column
-- of self-references.
ALTER TABLE "bookings" ADD COLUMN "financial_root_booking_id" TEXT;

WITH RECURSIVE booking_roots AS (
  SELECT id AS booking_id, id AS root_id
  FROM "bookings"
  WHERE "rescheduled_from_booking_id" IS NULL
  UNION ALL
  SELECT child.id, booking_roots.root_id
  FROM "bookings" child
  JOIN booking_roots ON child."rescheduled_from_booking_id" = booking_roots.booking_id
)
UPDATE "bookings" booking
SET "financial_root_booking_id" = booking_roots.root_id
FROM booking_roots
WHERE booking.id = booking_roots.booking_id
  AND booking.id <> booking_roots.root_id;

-- RESTRICT, not CASCADE: a root that still has replacements pointing at it holds the
-- payment they read, and deleting it would silently detach their money.
ALTER TABLE "bookings"
  ADD CONSTRAINT "bookings_financial_root_booking_id_fkey"
  FOREIGN KEY ("financial_root_booking_id") REFERENCES "bookings"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE
  NOT VALID;

ALTER TABLE "bookings"
  VALIDATE CONSTRAINT "bookings_financial_root_booking_id_fkey";

-- Prisma 7 does not wrap PostgreSQL custom migrations in a transaction.
CREATE INDEX CONCURRENTLY "bookings_financial_root_booking_id_idx"
  ON "bookings"("financial_root_booking_id");
