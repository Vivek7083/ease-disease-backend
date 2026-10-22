-- HAND-WRITTEN (Prisma cannot express the partial backfill below).
--
-- B2. `confirmed_at` records the moment a booking REACHED `CONFIRMED` (set by the payment handler in the same guarded update
-- that sets the status). The daily cap ("at most 5 bookings confirmed today, India time") counts it. It is never cleared
-- when the booking later becomes COMPLETED / CANCELLED / NO_SHOW: the booking still reached CONFIRMED that day.
--
-- Backfill for rows that already reached CONFIRMED before this column existed: the time their payment succeeded
-- (`transactions.completed_at`), else the last time the row changed. Rows that never reached CONFIRMED stay NULL
-- (including NEEDS_ATTENTION, whose payment may have succeeded but whose booking was held for a human).
--
-- HAND-ADDED TRANSACTION (same reason as the earlier migrations): without BEGIN/COMMIT a failing statement would leave the
-- column behind.

BEGIN;

-- AlterTable
ALTER TABLE "bookings" ADD COLUMN "confirmed_at" TIMESTAMPTZ(3);

-- Backfill
UPDATE "bookings" AS b
SET "confirmed_at" = COALESCE(
  (SELECT t."completed_at" FROM "transactions" AS t WHERE t."booking_id" = b."id" AND t."status" = 'SUCCESS'),
  b."updated_at"
)
WHERE b."status" IN ('CONFIRMED', 'COMPLETED', 'NO_SHOW')
   OR (b."status" = 'CANCELLED' AND EXISTS (SELECT 1 FROM "transactions" AS t WHERE t."booking_id" = b."id" AND t."status" = 'SUCCESS'));

-- CreateIndex
CREATE INDEX "bookings_user_id_confirmed_at_idx" ON "bookings"("user_id", "confirmed_at");

COMMIT;
