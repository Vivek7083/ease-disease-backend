-- B4 + B5.
--
-- Drops `bookings.hold_expires_at`: a leftover of the slot design (a payment window that expired holds). Nothing reads it,
-- nothing sets it, and nothing is in production. Adds the index My Bookings pages on: newest first for one person,
-- ties broken by id (the order of the keyset cursor).
--
-- HAND-ADDED TRANSACTION (same reason as the earlier migrations): without BEGIN/COMMIT a failing statement would leave the
-- earlier ones applied.

BEGIN;

-- AlterTable
ALTER TABLE "bookings" DROP COLUMN "hold_expires_at";

-- CreateIndex
CREATE INDEX "bookings_user_id_created_at_id_idx" ON "bookings"("user_id", "created_at" DESC, "id" DESC);

COMMIT;
