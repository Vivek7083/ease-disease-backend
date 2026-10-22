-- HAND-WRITTEN (Prisma cannot express CHECK constraints; see the header of schema.prisma).
--
-- S2d. `users.auth_provider` stays and keeps meaning "how the person first signed up". A new column,
-- `last_auth_provider`, records how they signed in most recently (updated by POST /v1/auth/sync only).
-- Existing rows get their first method copied into it, so the column can be NOT NULL straight away.
--
-- Backstop CHECKs (the application normalises and validates first, these refuse a future code mistake):
--   email: already lower-cased and trimmed, 3-254 characters.
--   both provider columns: one of the two labels we offer.
--
-- HAND-ADDED TRANSACTION (same reason as the B0 migration): without BEGIN/COMMIT a failing CHECK would leave the
-- new column behind. If it fails on an existing row, Prisma prints only "current transaction is aborted"; the real
-- first error names the constraint (for example `users_email_normalized_chk`). Fix or delete the offending row (nothing
-- is in production), run `prisma migrate resolve --rolled-back 20261023000000_users_guards_and_last_provider`, deploy again.

BEGIN;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "last_auth_provider" TEXT;
UPDATE "users" SET "last_auth_provider" = "auth_provider";
ALTER TABLE "users" ALTER COLUMN "last_auth_provider" SET NOT NULL;

-- Checks
ALTER TABLE "users" ADD CONSTRAINT "users_email_normalized_chk" CHECK ("email" = lower(btrim("email")));
ALTER TABLE "users" ADD CONSTRAINT "users_email_length_chk" CHECK (char_length("email") BETWEEN 3 AND 254);
ALTER TABLE "users" ADD CONSTRAINT "users_auth_provider_chk" CHECK ("auth_provider" IN ('google.com', 'emailLink'));
ALTER TABLE "users" ADD CONSTRAINT "users_last_auth_provider_chk" CHECK ("last_auth_provider" IN ('google.com', 'emailLink'));

COMMIT;
