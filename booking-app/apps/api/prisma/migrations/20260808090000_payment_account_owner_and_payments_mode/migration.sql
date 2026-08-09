-- CreateEnum
CREATE TYPE "PaymentsMode" AS ENUM ('PLATFORM', 'CONNECT');

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "payments_mode" "PaymentsMode" NOT NULL DEFAULT 'CONNECT',
ADD COLUMN     "stripe_account_updated_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "stripe_account_id" TEXT;

-- Backfill: every organization that exists before this migration predates Stripe
-- Connect and is charged on the platform account. The column default is CONNECT
-- because that is what a newly registered organizer must be, so the rows that were
-- already there have to be corrected explicitly rather than inheriting it.
UPDATE "organizations" SET "payments_mode" = 'PLATFORM';

-- Payments keep NULL, which means "the platform account" — correct for every row
-- written before this migration, since no charge had ever been created on a
-- connected account.
