-- AlterTable
-- A RECONCILE event is PayU's own answer to our verify_payment call: it carries no hash, so "was the hash valid" has no answer.
-- NULL means "not applicable" and must never be read as an attack (false means a signed payload failed its check).
ALTER TABLE "payment_events" ALTER COLUMN "hash_valid" DROP NOT NULL;

-- HAND-WRITTEN: only RECONCILE events may omit the hash result. A callback or webhook always records true or false.
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_hash_valid_null_only_reconcile" CHECK ("hash_valid" IS NOT NULL OR "source" = 'RECONCILE');

-- The append-only trigger already compares hash_valid with IS DISTINCT FROM, which treats NULL correctly: no trigger change needed.
