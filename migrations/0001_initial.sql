-- Migration: initial schema for CubaGest on D1 (SQLite)

CREATE TABLE IF NOT EXISTS "companies" (
  "id" TEXT PRIMARY KEY,
  "name" TEXT NOT NULL,
  "nit" TEXT,
  "default_currency" TEXT NOT NULL DEFAULT 'CUP',
  "tax_rate" REAL NOT NULL DEFAULT 0,
  "active" INTEGER NOT NULL DEFAULT 1,
  "plan" TEXT NOT NULL DEFAULT 'empresarial',
  "plan_expiry" INTEGER,
  "subscription_status" TEXT NOT NULL DEFAULT 'trial',
  "payment_method" TEXT,
  "qvapay_user_uuid" TEXT,
  "qvapay_authorized" INTEGER NOT NULL DEFAULT 0,
  "last_payment_date" INTEGER,
  "next_payment_date" INTEGER,
  "failed_attempts" INTEGER NOT NULL DEFAULT 0,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "users" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "email" TEXT NOT NULL,
  "password_hash" TEXT NOT NULL,
  "role" TEXT NOT NULL DEFAULT 'cajero',
  "nit" TEXT,
  "active" INTEGER NOT NULL DEFAULT 1,
  "last_login_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS "users_company_idx" ON "users"("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_idx" ON "users"("company_id", "email");

CREATE TABLE IF NOT EXISTS "products" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "code" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'Otros',
  "unit" TEXT NOT NULL DEFAULT 'ud',
  "price" REAL NOT NULL,
  "cost" REAL NOT NULL DEFAULT 0,
  "stock" REAL NOT NULL DEFAULT 0,
  "min_stock" REAL NOT NULL DEFAULT 0,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch()),
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS "products_company_idx" ON "products"("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "products_code_idx" ON "products"("company_id", "code");

CREATE TABLE IF NOT EXISTS "sales" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "invoice_number" TEXT NOT NULL,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE SET NULL,
  "date" TEXT NOT NULL,
  "client_name" TEXT NOT NULL DEFAULT 'Consumidor Final',
  "client_nit" TEXT,
  "client_phone" TEXT,
  "subtotal" REAL NOT NULL,
  "tax" REAL NOT NULL DEFAULT 0,
  "total" REAL NOT NULL,
  "currency" TEXT NOT NULL DEFAULT 'CUP',
  "pay_method" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'emitida',
  "synced_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS "sales_company_idx" ON "sales"("company_id");
CREATE UNIQUE INDEX IF NOT EXISTS "sales_invoice_idx" ON "sales"("company_id", "invoice_number");
CREATE INDEX IF NOT EXISTS "sales_date_idx" ON "sales"("date");
CREATE INDEX IF NOT EXISTS "sales_status_idx" ON "sales"("status");

CREATE TABLE IF NOT EXISTS "sale_items" (
  "id" TEXT PRIMARY KEY,
  "sale_id" TEXT NOT NULL REFERENCES "sales"("id") ON DELETE CASCADE,
  "product_id" TEXT REFERENCES "products"("id") ON DELETE SET NULL,
  "name" TEXT NOT NULL,
  "qty" REAL NOT NULL,
  "price" REAL NOT NULL,
  "total" REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS "expenses" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "date" TEXT NOT NULL,
  "concept" TEXT NOT NULL,
  "amount" REAL NOT NULL,
  "category" TEXT NOT NULL DEFAULT 'Otros',
  "method" TEXT NOT NULL,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS "expenses_company_idx" ON "expenses"("company_id");
CREATE INDEX IF NOT EXISTS "expenses_date_idx" ON "expenses"("date");

CREATE TABLE IF NOT EXISTS "stock_movements" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "product_id" TEXT NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "type" TEXT NOT NULL,
  "qty" REAL NOT NULL,
  "reason" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS "sm_company_idx" ON "stock_movements"("company_id");
CREATE INDEX IF NOT EXISTS "sm_product_idx" ON "stock_movements"("product_id");

CREATE TABLE IF NOT EXISTS "inventory_readings" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "taken_by_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" TEXT NOT NULL,
  "notes" TEXT,
  "items" TEXT NOT NULL DEFAULT '[]',
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "cash_closings" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "closed_by_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "initial_reading_id" TEXT NOT NULL REFERENCES "inventory_readings"("id"),
  "closing_reading_id" TEXT REFERENCES "inventory_readings"("id"),
  "period_start" INTEGER NOT NULL,
  "period_end" INTEGER NOT NULL,
  "total_sales" INTEGER NOT NULL DEFAULT 0,
  "total_income" REAL NOT NULL DEFAULT 0,
  "income_efectivo" REAL NOT NULL DEFAULT 0,
  "income_transferencia" REAL NOT NULL DEFAULT 0,
  "items" TEXT NOT NULL DEFAULT '[]',
  "notes" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "audit_logs" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "action" TEXT NOT NULL,
  "entity" TEXT NOT NULL,
  "entity_id" TEXT,
  "detail" TEXT,
  "ip" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE IF NOT EXISTS "refresh_tokens" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Tabla de contadores atómicos para:
-- 1. Numeración correlativa de facturas: "invoice:{companyId}:{year}"
-- 2. Rate limiting de login por IP: "ratelimit:{ip}:{ventana}"
CREATE TABLE IF NOT EXISTS "counters" (
  "id" TEXT PRIMARY KEY,
  "value" INTEGER NOT NULL DEFAULT 0
);
