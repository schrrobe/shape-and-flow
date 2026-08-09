-- office_users.email moves from a per-organization unique index to a global one: login
-- and password reset resolve an office user by address alone now, with no organization
-- known yet, so the address has to name exactly one account across every tenant.
--
-- Fail loudly before touching a row. Under the old (organization_id, email) index,
-- "Robert@x" and "robert@x" could coexist as two separate accounts — in the same
-- organization, or in two different ones, since email was case-sensitive and scoped.
-- Lowercasing below would silently fold such a pair into one row, and this migration
-- has no business deciding which of two real accounts wins. If that has actually
-- happened, an operator needs to merge or rename the colliding rows by hand; refusing
-- here is cheaper than guessing.
DO $$
DECLARE
  collisions integer;
BEGIN
  SELECT count(*) INTO collisions
  FROM (
    SELECT lower(email) AS normalized
    FROM "office_users"
    GROUP BY lower(email)
    HAVING count(*) > 1
  ) AS duplicates;

  IF collisions > 0 THEN
    RAISE EXCEPTION
      'office_user_email_global_unique: % email(s) collide once lowercased; resolve the duplicate office_users rows by hand before re-running this migration',
      collisions;
  END IF;
END $$;

-- Backfill before the new index exists, not after: creating the unique index first and
-- normalizing afterward would let the same collision surface as a mid-migration failure
-- instead of the clear error above, and leave the drop of the old index already applied.
UPDATE "office_users" SET email = lower(email) WHERE email <> lower(email);

-- DropIndex
DROP INDEX "office_users_organization_id_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "office_users_email_key" ON "office_users"("email");
