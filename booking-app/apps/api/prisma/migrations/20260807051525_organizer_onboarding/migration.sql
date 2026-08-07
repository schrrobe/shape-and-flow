/*
  Warnings:

  - A unique constraint covering the columns `[stripe_account_id]` on the table `organizations` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateEnum
CREATE TYPE "EntityType" AS ENUM ('INDIVIDUAL', 'SOLE_PROPRIETORSHIP', 'ORGANIZATION');

-- AlterEnum
ALTER TYPE "AuditAction" ADD VALUE 'ORGANIZATION_ONBOARDING_LINK_REQUESTED';

-- AlterTable
ALTER TABLE "organizations" ADD COLUMN     "entityType" "EntityType",
ADD COLUMN     "isSmallBusiness" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "ownerFirstName" TEXT,
ADD COLUMN     "ownerLastName" TEXT,
ADD COLUMN     "stripeChargesEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "stripeDetailsSubmitted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "taxId" TEXT,
ADD COLUMN     "vatId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "organizations_stripe_account_id_key" ON "organizations"("stripe_account_id");
