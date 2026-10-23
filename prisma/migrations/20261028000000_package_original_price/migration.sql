-- Packages gain an optional "old price" (the figure the site shows struck through next to the real price).
-- NULL means there is no old price to show. When set it must be higher than the current price, so a struck-through
-- figure can never be lower than what is charged.
-- The launch package shows 5000 rupees struck through today, so it gets that value (only if its price is lower).
-- HAND-ADDED TRANSACTION (same reason as the earlier migrations): a failing statement must not leave the column behind.

BEGIN;

ALTER TABLE "packages" ADD COLUMN "original_price_paise" INTEGER;

UPDATE "packages" SET "original_price_paise" = 500000
WHERE "id" = '00000000-0000-4000-8000-000000000001' AND "price_paise" < 500000;

ALTER TABLE "packages" ADD CONSTRAINT "packages_original_price_check"
  CHECK ("original_price_paise" IS NULL OR "original_price_paise" > "price_paise");

COMMIT;
