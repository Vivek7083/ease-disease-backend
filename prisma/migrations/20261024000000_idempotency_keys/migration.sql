-- HAND-WRITTEN (Prisma cannot express CHECK constraints; see the header of schema.prisma).
--
-- B1. One row per (Idempotency-Key, person, endpoint). The row is written in the SAME transaction as the thing it
-- protects (for bookings: the booking itself), and `response` is filled before that transaction commits, so a
-- committed row always carries the original answer. While another request holds an uncommitted row with the same key,
-- a second INSERT waits for it (primary key), which is what stops two simultaneous identical requests from both
-- creating a booking. Rows older than 24 hours are taken over by the application, so correctness never depends on a purge.
--
-- HAND-ADDED TRANSACTION (same reason as the B0 migration): without BEGIN/COMMIT a failing statement would leave the
-- table behind.

BEGIN;

-- CreateTable
CREATE TABLE "idempotency_keys" (
    "key" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "endpoint" TEXT NOT NULL,
    "request_hash" TEXT NOT NULL,
    "response" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_keys_pkey" PRIMARY KEY ("key","user_id","endpoint")
);

-- CreateIndex
CREATE INDEX "idempotency_keys_created_at_idx" ON "idempotency_keys"("created_at");

-- AddForeignKey
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Checks: sha-256 in lower-case hex; a non-empty endpoint label.
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_request_hash_chk" CHECK ("request_hash" ~ '^[0-9a-f]{64}$');
ALTER TABLE "idempotency_keys" ADD CONSTRAINT "idempotency_keys_endpoint_chk" CHECK (char_length("endpoint") BETWEEN 1 AND 100);

COMMIT;
