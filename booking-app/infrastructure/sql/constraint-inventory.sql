-- Does this database still enforce what the application assumes it enforces?
--
-- Run with ON_ERROR_STOP so a missing object is an exit code, not a line of output
-- somebody has to notice:
--
--     psql -v ON_ERROR_STOP=1 -f constraint-inventory.sql
--
-- Two callers, deliberately the same file:
--
--   * infrastructure/scripts/restore.sh, immediately after a restore
--   * the deploy-check job in CI, immediately after `migrate deploy`
--
-- ── Why this exists ─────────────────────────────────────────────────────────
--
-- Almost every rule below is also enforced in TypeScript, and every one of those
-- checks can be bypassed: by a migration that dropped a constraint as a side effect,
-- by a restore that silently omitted one, by a `psql` session at three in the morning.
-- The database is the last place a double booking can be refused, and a lost exclusion
-- constraint is invisible — the application keeps working, right up until two customers
-- arrive for the same appointment.
--
-- Prisma's default strategy for changing an enum is to create a new type, swap the
-- column and drop the old one, which takes any dependent constraint with it. That is
-- the specific accident this file is looking for.

\set ON_ERROR_STOP on

DO $inventory$
DECLARE
  -- Table constraints: exclusion and check. A missing one means the database will
  -- accept a row the domain considers impossible.
  expected_constraints text[] := ARRAY[
    'bookings_no_overlap',
    'blocked_times_no_overlap',
    'bookings_block_range_check',
    'bookings_customer_range_check',
    'bookings_expires_at_matches_status',
    'blocked_times_range_check',
    'working_hours_minutes_check',
    'breaks_minutes_check',
    'availability_exceptions_shape_check',
    'time_off_range_check',
    'services_duration_check',
    'services_buffers_check',
    'services_price_check',
    'payments_amount_check',
    'payments_refunded_check',
    'manual_payments_amount_check',
    'refunds_amount_check',
    'organization_settings_ranges_check'
  ];

  -- Unique and partial-unique indexes that carry a rule rather than a lookup. The
  -- two `_one_open` indexes are what stops a booking accumulating two undecided
  -- requests; the rest are the uniqueness every idempotency and webhook path relies on.
  expected_indexes text[] := ARRAY[
    'cancellation_requests_one_open',
    'reschedule_requests_one_open',
    'bookings_organization_id_reference_key',
    'bookings_stripe_checkout_session_id_key',
    'customers_organization_id_email_normalized_key',
    'management_tokens_token_hash_key',
    'notifications_dedupe_key_key',
    'notifications_provider_message_id_key',
    'stripe_webhook_events_stripe_event_id_key',
    'messaging_webhook_events_provider_provider_event_id_key',
    'idempotency_keys_key_key',
    'refunds_idempotency_key_key',
    'payments_stripe_payment_intent_id_key',
    'organizations_slug_key'
  ];

  missing text[];
  wrong_kind text[];
  predicate text;
BEGIN
  -- btree_gist first: without it the two exclusion constraints cannot exist at all,
  -- and reporting eighteen missing constraints would bury the one cause.
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'btree_gist') THEN
    RAISE EXCEPTION
      'constraint inventory: the btree_gist extension is missing, so no exclusion constraint can exist. The database user needs CREATE on this database, or a superuser must run: CREATE EXTENSION btree_gist;';
  END IF;

  SELECT array_agg(name ORDER BY name) INTO missing
  FROM unnest(expected_constraints) AS name
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_constraint c
    JOIN pg_namespace n ON n.oid = c.connamespace
    WHERE c.conname = name AND n.nspname = 'public'
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'constraint inventory: % constraint(s) missing: %',
      cardinality(missing), array_to_string(missing, ', ');
  END IF;

  SELECT array_agg(name ORDER BY name) INTO missing
  FROM unnest(expected_indexes) AS name
  WHERE NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE schemaname = 'public' AND indexname = name
  );

  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'constraint inventory: % index(es) missing: %',
      cardinality(missing), array_to_string(missing, ', ');
  END IF;

  -- Present is not the same as still being an exclusion constraint. A constraint
  -- recreated by hand as a plain CHECK would pass the name test above and enforce
  -- nothing about overlap.
  SELECT array_agg(c.conname ORDER BY c.conname) INTO wrong_kind
  FROM pg_constraint c
  WHERE c.conname IN ('bookings_no_overlap', 'blocked_times_no_overlap')
    AND c.contype <> 'x';

  IF wrong_kind IS NOT NULL THEN
    RAISE EXCEPTION 'constraint inventory: % is no longer an exclusion constraint',
      array_to_string(wrong_kind, ', ');
  END IF;

  -- The predicate is the part that decides *which* bookings block each other. A
  -- migration that added a status without adding it here would leave that status
  -- freely double-bookable, and nothing else in the system would notice.
  SELECT pg_get_constraintdef(oid) INTO predicate
  FROM pg_constraint WHERE conname = 'bookings_no_overlap';

  IF predicate NOT LIKE '%PENDING_PAYMENT%'
     OR predicate NOT LIKE '%EXPIRING%'
     OR predicate NOT LIKE '%CONFIRMED%' THEN
    RAISE EXCEPTION
      'constraint inventory: bookings_no_overlap no longer covers all three blocking statuses. Its definition is: %', predicate;
  END IF;

  RAISE NOTICE 'constraint inventory: % constraints and % indexes present, both exclusion constraints intact.',
    cardinality(expected_constraints), cardinality(expected_indexes);
END
$inventory$;
