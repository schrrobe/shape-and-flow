-- Confirmations get their own switch. Previously they rode on `sms_reminders_enabled`,
-- which covers reminders and nothing else, so a business that wanted reminders was billed
-- for a confirmation text per booking as well.
--
-- Backfilled from the reminder flag rather than defaulted to false, so no organization
-- silently stops receiving something it is receiving today. New organizations get the
-- column default.
ALTER TABLE "organization_settings"
  ADD COLUMN "sms_confirmations_enabled" BOOLEAN NOT NULL DEFAULT false;

UPDATE "organization_settings"
  SET "sms_confirmations_enabled" = "sms_reminders_enabled";
