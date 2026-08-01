-- Runs once, when the data volume is first created.
--
-- The shadow database is what `prisma migrate diff --from-migrations` and `prisma migrate
-- dev` build the migration history into. Prisma 7 will not create it: the URL has to be in
-- `prisma.config.ts`, and a missing database is a hard P1003. Creating it here keeps the
-- schema-drift gate runnable on a fresh clone with nothing but `pnpm db:up`.
CREATE DATABASE booking_shadow OWNER booking;
