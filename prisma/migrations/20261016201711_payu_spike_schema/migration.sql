-- CreateEnum
CREATE TYPE "booking_status" AS ENUM ('PENDING_PAYMENT', 'CONFIRMED', 'COMPLETED', 'CANCELLED', 'NO_SHOW', 'EXPIRED', 'NEEDS_ATTENTION');

-- CreateEnum
CREATE TYPE "transaction_status" AS ENUM ('CREATED', 'INITIATED', 'SUCCESS', 'FAILURE', 'PENDING', 'CANCELLED', 'EXPIRED');

-- AlterTable
-- HAND-EDITED: the original columns were `timestamp` (no zone) holding UTC wall-clock values (the app
-- only ever wrote UTC). `USING ... AT TIME ZONE 'UTC'` makes the conversion keep the exact instant
-- regardless of the TimeZone setting of the session that runs this migration.
ALTER TABLE "users"
ALTER COLUMN "last_login_at" SET DATA TYPE TIMESTAMPTZ(3) USING "last_login_at" AT TIME ZONE 'UTC',
ALTER COLUMN "created_at" DROP DEFAULT,
ALTER COLUMN "created_at" SET DATA TYPE TIMESTAMPTZ(3) USING "created_at" AT TIME ZONE 'UTC',
ALTER COLUMN "created_at" SET DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "updated_at" SET DATA TYPE TIMESTAMPTZ(3) USING "updated_at" AT TIME ZONE 'UTC';

-- CreateTable
CREATE TABLE "packages" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" JSONB NOT NULL,
    "price_paise" INTEGER NOT NULL,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "packages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "bookings" (
    "id" UUID NOT NULL,
    "reference" TEXT NOT NULL,
    "user_id" UUID NOT NULL,
    "package_id" UUID NOT NULL,
    "status" "booking_status" NOT NULL DEFAULT 'PENDING_PAYMENT',
    "package_title" TEXT NOT NULL,
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "patient_name" TEXT NOT NULL,
    "patient_dob" DATE,
    "notes" TEXT,
    "consent_at" TIMESTAMPTZ(3) NOT NULL,
    "hold_expires_at" TIMESTAMPTZ(3),
    "scheduled_at" TIMESTAMPTZ(3),
    "expert_notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "bookings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "transactions" (
    "id" UUID NOT NULL,
    "order_id" TEXT NOT NULL,
    "booking_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "gateway" TEXT NOT NULL DEFAULT 'PAYU',
    "amount_paise" INTEGER NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'INR',
    "status" "transaction_status" NOT NULL DEFAULT 'CREATED',
    "payment_mode" TEXT,
    "pg_txn_id" TEXT,
    "bank_ref_num" TEXT,
    "error_code" TEXT,
    "error_message" TEXT,
    "completed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "transactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_events" (
    "id" UUID NOT NULL,
    "transaction_id" UUID,
    "source" TEXT NOT NULL,
    "hash_valid" BOOLEAN NOT NULL,
    "payload" JSONB NOT NULL,
    "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "payment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outbox" (
    "id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_error" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "outbox_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "packages_is_active_idx" ON "packages"("is_active");

-- CreateIndex
CREATE UNIQUE INDEX "bookings_reference_key" ON "bookings"("reference");

-- CreateIndex
CREATE INDEX "bookings_user_id_status_idx" ON "bookings"("user_id", "status");

-- CreateIndex
CREATE UNIQUE INDEX "transactions_order_id_key" ON "transactions"("order_id");

-- CreateIndex
CREATE INDEX "transactions_booking_id_idx" ON "transactions"("booking_id");

-- CreateIndex
CREATE INDEX "transactions_status_updated_at_idx" ON "transactions"("status", "updated_at");

-- CreateIndex
CREATE INDEX "payment_events_transaction_id_idx" ON "payment_events"("transaction_id");

-- CreateIndex
CREATE INDEX "outbox_status_next_attempt_at_idx" ON "outbox"("status", "next_attempt_at");

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_package_id_fkey" FOREIGN KEY ("package_id") REFERENCES "packages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_booking_id_fkey" FOREIGN KEY ("booking_id") REFERENCES "bookings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_events" ADD CONSTRAINT "payment_events_transaction_id_fkey" FOREIGN KEY ("transaction_id") REFERENCES "transactions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- HAND-WRITTEN: constraints Prisma cannot express.
ALTER TABLE "packages" ADD CONSTRAINT "packages_price_paise_nonneg" CHECK ("price_paise" >= 0);
ALTER TABLE "packages" ADD CONSTRAINT "packages_description_is_array" CHECK (jsonb_typeof("description") = 'array');
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_amount_paise_nonneg" CHECK ("amount_paise" >= 0);
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_paise_nonneg" CHECK ("amount_paise" >= 0);
