-- HAND-WRITTEN (Prisma cannot express CHECK constraints; see the header of schema.prisma).
--
-- The booking form's contact details live on the booking as `consultee_*` columns: the person the
-- consultation is for, which may differ from the signed-in account. `patient_name` / `patient_dob` become
-- `consultee_name` / `consultee_dob` so the whole group reads the same way.
--
-- The four required columns have NO default on purpose: this migration fails on a table that already holds
-- bookings instead of inventing contact data for them. Nothing is in production; empty the table first.
-- Every limit below is also checked by the application (booking creation); these are the backstop.
--
-- HAND-ADDED TRANSACTION: Prisma does not wrap a migration file in one transaction, so without BEGIN/COMMIT a
-- failure part-way (for example the NOT NULL columns meeting existing bookings) would leave the renames applied.
-- With it the migration is all-or-nothing (proven on a scratch database holding an old-style booking: nothing changed).
-- If it fails on existing bookings, Prisma prints only "current transaction is aborted"; the real first error is
-- `column "consultee_whatsapp_number" of relation "bookings" contains null values`. To recover: remove or backfill
-- the bookings, run `prisma migrate resolve --rolled-back 20261022000000_booking_contact_fields`, deploy again.

BEGIN;

-- RenameColumn
ALTER TABLE "bookings" RENAME COLUMN "patient_name" TO "consultee_name";
ALTER TABLE "bookings" RENAME COLUMN "patient_dob" TO "consultee_dob";

-- AlterTable
ALTER TABLE "bookings"
ADD COLUMN "consultee_whatsapp_number" TEXT NOT NULL,
ADD COLUMN "consultee_email" TEXT NOT NULL,
ADD COLUMN "consultee_age" SMALLINT NOT NULL,
ADD COLUMN "consultee_city" TEXT NOT NULL,
ADD COLUMN "consultee_gender" TEXT,
ADD COLUMN "created_ip" TEXT,
ADD COLUMN "created_user_agent" TEXT;

-- AlterTable
ALTER TABLE "transactions"
ADD COLUMN "created_ip" TEXT,
ADD COLUMN "created_user_agent" TEXT;

-- E.164 with country code: "+", then 8 to 15 digits, first digit 1-9, nothing else (no spaces).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_consultee_whatsapp_number_e164"
  CHECK ("consultee_whatsapp_number" ~ '^\+[1-9][0-9]{7,14}$');

-- Same character rule and 50-character cap that checkout enforces for PayU (`validateEmail`), stored lower-case.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_consultee_email_shape"
  CHECK (
    "consultee_email" = lower("consultee_email")
    AND char_length("consultee_email") <= 50
    AND "consultee_email" ~ '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'
  );

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_consultee_age_range"
  CHECK ("consultee_age" BETWEEN 1 AND 119);

ALTER TABLE "bookings" ADD CONSTRAINT "bookings_consultee_city_shape"
  CHECK ("consultee_city" = btrim("consultee_city") AND char_length("consultee_city") BETWEEN 2 AND 100);

-- Optional free text: "not given" is NULL, never an empty string.
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_consultee_gender_shape"
  CHECK ("consultee_gender" IS NULL OR ("consultee_gender" = btrim("consultee_gender") AND char_length("consultee_gender") BETWEEN 1 AND 50));

-- 45 = longest textual IPv6 address (same convention as payment_events.source_ip).
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_ip_length"
  CHECK ("created_ip" IS NULL OR char_length("created_ip") BETWEEN 1 AND 45);
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_created_user_agent_length"
  CHECK ("created_user_agent" IS NULL OR char_length("created_user_agent") BETWEEN 1 AND 512);

ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_ip_length"
  CHECK ("created_ip" IS NULL OR char_length("created_ip") BETWEEN 1 AND 45);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_created_user_agent_length"
  CHECK ("created_user_agent" IS NULL OR char_length("created_user_agent") BETWEEN 1 AND 512);

COMMIT;
