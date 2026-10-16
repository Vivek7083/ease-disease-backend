-- AlterEnum
-- A failed or cancelled payment marks the booking FAILED. (A new enum value cannot be used in the
-- same transaction that adds it; nothing in this migration uses it.)
ALTER TYPE "booking_status" ADD VALUE 'FAILED';

-- DropForeignKey
ALTER TABLE "payment_events" DROP CONSTRAINT "payment_events_transaction_id_fkey";

-- DropIndex
DROP INDEX "transactions_booking_id_idx";

-- AlterTable
ALTER TABLE "payment_events" ADD COLUMN     "verification" JSONB;

-- CreateIndex
-- One booking, one transaction for now. Retries later = drop this index (see the P4 plan).
CREATE UNIQUE INDEX "transactions_booking_id_key" ON "transactions"("booking_id");

-- AddForeignKey
-- RESTRICT (was SET NULL): an event must never be silently detached from its transaction.
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- HAND-WRITTEN: payment_events is an append-only audit log, enforced by the database.
--  * DELETE is refused.
--  * UPDATE is allowed only to fill `verification` once (NULL -> value); every other column must
--    be unchanged, so the raw payload we received can never be altered.
-- (TRUNCATE is deliberately not blocked here: the test helpers rely on it. Production access
--  control for that belongs to the database role, not this trigger.)
CREATE FUNCTION "payment_events_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payment_events is append-only: DELETE is not allowed';
  END IF;

  IF OLD."verification" IS NOT NULL THEN
    RAISE EXCEPTION 'payment_events is append-only: verification is already set';
  END IF;

  IF NEW."verification" IS NULL THEN
    RAISE EXCEPTION 'payment_events is append-only: UPDATE must set verification';
  END IF;

  IF (NEW."id", NEW."transaction_id", NEW."source", NEW."hash_valid", NEW."payload", NEW."received_at")
     IS DISTINCT FROM
     (OLD."id", OLD."transaction_id", OLD."source", OLD."hash_valid", OLD."payload", OLD."received_at") THEN
    RAISE EXCEPTION 'payment_events is append-only: only verification may be set';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER "payment_events_append_only"
BEFORE UPDATE OR DELETE ON "payment_events"
FOR EACH ROW EXECUTE FUNCTION "payment_events_guard"();
