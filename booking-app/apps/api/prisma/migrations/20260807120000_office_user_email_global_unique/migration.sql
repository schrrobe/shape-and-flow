-- DropIndex
DROP INDEX "office_users_organization_id_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "office_users_email_key" ON "office_users"("email");
