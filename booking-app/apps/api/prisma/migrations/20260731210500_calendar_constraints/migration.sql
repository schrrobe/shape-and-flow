-- Calendar integrity constraints.
--
-- HAND-WRITTEN. Do not regenerate this file.
--
-- `bookings_no_overlap` hard-codes BookingStatus literals in its predicate.
-- Prisma's default strategy for changing an enum is to create a new type, swap
-- the column and drop the old type, which silently drops any constraint that
-- depends on it. Every future migration that touches BookingStatus must
-- therefore be authored with `prisma migrate dev --create-only` and must either
-- use `ALTER TYPE ... ADD VALUE` or drop and recreate this constraint
-- explicitly in the same transaction.
--
-- test/integration/calendar-constraints.int.spec.ts asserts that all four
-- calendar constraints still exist after `migrate deploy`, and that the
-- predicate's literals match the BLOCKING_BOOKING_STATUSES constant, so a lost
-- constraint fails CI rather than surfacing as a double booking.

CREATE EXTENSION IF NOT EXISTS btree_gist;

-- ── bookings ────────────────────────────────────────────────────────────────
--
-- '[)' bounds — start inclusive, end exclusive — make back-to-back
-- appointments legal, which is the entire point of buffers being explicit.
--
-- organization_id in the key is redundant while an employee belongs to exactly
-- one organization. It is kept as defence in depth and as the seam the
-- multi-tenant future needs; the cost is one extra column in a GiST index.
--
-- The range CHECK closes a hole the exclusion constraint cannot: tstzrange(x, x)
-- is the empty range, which overlaps nothing, so without it an unlimited number
-- of zero-length bookings could stack on one instant.
ALTER TABLE bookings
  ADD CONSTRAINT bookings_block_range_check
    CHECK (block_ends_at > block_starts_at),
  ADD CONSTRAINT bookings_customer_range_check
    CHECK (ends_at > starts_at),
  ADD CONSTRAINT bookings_expires_at_matches_status
    CHECK (
      (status IN ('PENDING_PAYMENT', 'EXPIRING') AND expires_at IS NOT NULL)
      OR (status NOT IN ('PENDING_PAYMENT', 'EXPIRING') AND expires_at IS NULL)
    ),
  ADD CONSTRAINT bookings_no_overlap EXCLUDE USING gist (
    organization_id WITH =,
    employee_id     WITH =,
    tstzrange(block_starts_at, block_ends_at, '[)') WITH &&
  ) WHERE (status IN ('PENDING_PAYMENT', 'EXPIRING', 'CONFIRMED'));

-- ── blocked_times ───────────────────────────────────────────────────────────
--
-- No status predicate: a blocked time either exists or it does not.
ALTER TABLE blocked_times
  ADD CONSTRAINT blocked_times_range_check
    CHECK (ends_at > starts_at),
  ADD CONSTRAINT blocked_times_no_overlap EXCLUDE USING gist (
    organization_id WITH =,
    employee_id     WITH =,
    tstzrange(starts_at, ends_at, '[)') WITH &&
  );

-- ── at most one open request per booking ────────────────────────────────────
--
-- A partial unique index rather than a composite unique on (booking_id,
-- decision): a booking may accumulate many decided requests over time, but
-- never two undecided ones.
CREATE UNIQUE INDEX cancellation_requests_one_open
  ON cancellation_requests (booking_id)
  WHERE decision = 'PENDING';

CREATE UNIQUE INDEX reschedule_requests_one_open
  ON reschedule_requests (booking_id)
  WHERE decision = 'PENDING';

-- ── minute-of-day ranges ────────────────────────────────────────────────────
--
-- 1440 is a legal end value and means local midnight.
ALTER TABLE working_hours
  ADD CONSTRAINT working_hours_minutes_check
    CHECK (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute);

ALTER TABLE breaks
  ADD CONSTRAINT breaks_minutes_check
    CHECK (start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute);

-- CLOSED removes the whole day and must carry no minutes; EXTRA_HOURS replaces
-- the day's recurring hours and must carry both. A half-specified exception
-- would make the availability engine's behaviour undefined.
ALTER TABLE availability_exceptions
  ADD CONSTRAINT availability_exceptions_shape_check
    CHECK (
      (kind = 'CLOSED' AND start_minute IS NULL AND end_minute IS NULL)
      OR (
        kind = 'EXTRA_HOURS'
        AND start_minute IS NOT NULL AND end_minute IS NOT NULL
        AND start_minute >= 0 AND end_minute <= 1440 AND end_minute > start_minute
      )
    );

-- Inclusive date range: end_date is a day the employee is away.
ALTER TABLE time_off
  ADD CONSTRAINT time_off_range_check CHECK (end_date >= start_date);

-- ── catalog value ranges ────────────────────────────────────────────────────
ALTER TABLE services
  ADD CONSTRAINT services_duration_check
    CHECK (duration_minutes BETWEEN 5 AND 480),
  ADD CONSTRAINT services_buffers_check
    CHECK (prep_buffer_minutes BETWEEN 0 AND 120 AND cleanup_buffer_minutes BETWEEN 0 AND 120),
  ADD CONSTRAINT services_price_check
    CHECK (price_cents >= 0);

-- ── money ───────────────────────────────────────────────────────────────────
ALTER TABLE payments
  ADD CONSTRAINT payments_amount_check
    CHECK (amount_cents > 0),
  ADD CONSTRAINT payments_refunded_check
    CHECK (refunded_amount_cents >= 0 AND refunded_amount_cents <= amount_cents);

-- A negative amount is legal and is how a mis-keyed cash payment is corrected;
-- zero never is.
ALTER TABLE manual_payments
  ADD CONSTRAINT manual_payments_amount_check
    CHECK (amount_cents <> 0);

ALTER TABLE refunds
  ADD CONSTRAINT refunds_amount_check
    CHECK (amount_cents > 0);

-- ── settings ────────────────────────────────────────────────────────────────
--
-- Mirrors the bounds the Zod contract enforces, so a value that bypasses the
-- API cannot corrupt the availability engine's assumptions.
ALTER TABLE organization_settings
  ADD CONSTRAINT organization_settings_ranges_check
    CHECK (
      scheduling_interval_minutes IN (5, 10, 15, 20, 30, 60)
      AND booking_horizon_days BETWEEN 1 AND 365
      AND minimum_notice_hours BETWEEN 0 AND 720
      AND reservation_ttl_minutes BETWEEN 3 AND 30
      AND free_cancellation_hours BETWEEN 0 AND 720
      AND cancellation_fee_percent BETWEEN 0 AND 100
      AND cancellation_fee_amount_cents >= 0
      AND data_retention_days BETWEEN 30 AND 3650
    );
