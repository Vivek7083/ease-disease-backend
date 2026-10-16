-- AlterTable
-- Client address of the inbound PayU callback / webhook request. NULL for RECONCILE events (no inbound request).
ALTER TABLE "payment_events" ADD COLUMN     "source_ip" TEXT;

-- HAND-WRITTEN: 45 characters is the longest textual IPv6 form (IPv4-mapped included).
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_source_ip_len" CHECK ("source_ip" IS NULL OR length("source_ip") BETWEEN 1 AND 45);

-- HAND-WRITTEN: the append-only guard must also protect source_ip from being altered after the fact.
CREATE OR REPLACE FUNCTION "payment_events_guard"() RETURNS trigger
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

  IF (NEW."id", NEW."transaction_id", NEW."source", NEW."hash_valid", NEW."payload", NEW."received_at", NEW."source_ip")
     IS DISTINCT FROM
     (OLD."id", OLD."transaction_id", OLD."source", OLD."hash_valid", OLD."payload", OLD."received_at", OLD."source_ip") THEN
    RAISE EXCEPTION 'payment_events is append-only: only verification may be set';
  END IF;

  RETURN NEW;
END;
$$;
