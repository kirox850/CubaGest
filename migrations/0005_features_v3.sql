-- Migration 0005 - Descuentos, multimoneda (settings), referidos, barcode

-- 1) Descuentos (solo admin crea/elimina)
CREATE TABLE IF NOT EXISTS "discounts" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "code" TEXT,
  "scope" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "value" REAL NOT NULL,
  "max_uses" INTEGER,
  "times_used" INTEGER NOT NULL DEFAULT 0,
  "location_scope" TEXT NOT NULL DEFAULT 'todas',
  "location_ids" TEXT NOT NULL DEFAULT '[]',
  "starts_at" INTEGER,
  "ends_at" INTEGER,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_by" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS "discounts_company_idx" ON "discounts"("company_id");

-- 2) Configuracion de empresa: monedas + tasa de cambio
CREATE TABLE IF NOT EXISTS "company_settings" (
  "company_id" TEXT PRIMARY KEY REFERENCES "companies"("id") ON DELETE CASCADE,
  "currencies" TEXT NOT NULL DEFAULT '["CUP"]',
  "rate_mode" TEXT NOT NULL DEFAULT 'manual',
  "manual_rates" TEXT NOT NULL DEFAULT '{}',
  "eltoque_rates" TEXT NOT NULL DEFAULT '{}',
  "eltoque_updated_at" INTEGER,
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

-- 3) Referidos
CREATE TABLE IF NOT EXISTS "referrals" (
  "id" TEXT PRIMARY KEY,
  "referrer_company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "referred_company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "status" TEXT NOT NULL DEFAULT 'pendiente',
  "bonus_plan" TEXT,
  "bonus_until" INTEGER,
  "bonified_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS "referrals_referred_idx" ON "referrals"("referred_company_id");
CREATE INDEX IF NOT EXISTS "referrals_referrer_idx" ON "referrals"("referrer_company_id");

-- 4) Codigo de barras + moneda en productos
ALTER TABLE "products" ADD COLUMN "barcode" TEXT;
ALTER TABLE "products" ADD COLUMN "currency" TEXT NOT NULL DEFAULT 'CUP';

-- 5) Descuento aplicado a la venta
ALTER TABLE "sales" ADD COLUMN "discount_code" TEXT;
ALTER TABLE "sales" ADD COLUMN "discount_total" REAL NOT NULL DEFAULT 0;
-- Nota: currency y pay_method ya son TEXT puro en SQLite: aceptan los nuevos
-- valores (usd, clasica, zelle, mlc, eur) sin ALTER. La validacion real
-- vive en la ruta de ventas.

-- 5b) Descuento aplicado a cada linea de venta
ALTER TABLE "sale_items" ADD COLUMN "discount_id" TEXT REFERENCES "discounts"("id");
ALTER TABLE "sale_items" ADD COLUMN "discount_amount" REAL NOT NULL DEFAULT 0;

-- 6) Codigo de referido en companies
ALTER TABLE "companies" ADD COLUMN "referral_code" TEXT;
ALTER TABLE "companies" ADD COLUMN "referred_by" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "companies_referral_code_idx" ON "companies"("referral_code");
