-- Packages gain the length of the consultation in minutes (shown on the site as "30 min").
-- Existing rows get 30; the temporary default is then dropped so a new package must say its length.
-- HAND-ADDED TRANSACTION (same reason as the earlier migrations): a failing statement must not leave the column behind.

BEGIN;

ALTER TABLE "packages" ADD COLUMN "duration_minutes" SMALLINT NOT NULL DEFAULT 30;
ALTER TABLE "packages" ALTER COLUMN "duration_minutes" DROP DEFAULT;
ALTER TABLE "packages" ADD CONSTRAINT "packages_duration_minutes_check" CHECK ("duration_minutes" BETWEEN 1 AND 600);

COMMIT;
