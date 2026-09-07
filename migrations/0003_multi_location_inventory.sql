-- Inventario multi-ubicación: un almacén central por empresa + una caja
-- independiente por cada cajero. El stock operativo vive en location_stock;
-- products.stock pasa a ser un total calculado (suma de todas las
-- ubicaciones), usado solo para el dashboard/alertas a nivel de empresa.

CREATE TABLE IF NOT EXISTS "inventory_locations" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL,
  "type" TEXT NOT NULL,
  "owner_user_id" TEXT REFERENCES "users"("id") ON DELETE SET NULL,
  "active" INTEGER NOT NULL DEFAULT 1,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS "locations_company_idx" ON "inventory_locations"("company_id");
CREATE INDEX IF NOT EXISTS "locations_owner_idx" ON "inventory_locations"("owner_user_id");

CREATE TABLE IF NOT EXISTS "location_stock" (
  "id" TEXT PRIMARY KEY,
  "location_id" TEXT NOT NULL REFERENCES "inventory_locations"("id") ON DELETE CASCADE,
  "product_id" TEXT NOT NULL REFERENCES "products"("id") ON DELETE CASCADE,
  "qty" REAL NOT NULL DEFAULT 0,
  "updated_at" INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE("location_id", "product_id")
);
CREATE INDEX IF NOT EXISTS "location_stock_location_idx" ON "location_stock"("location_id");
CREATE INDEX IF NOT EXISTS "location_stock_product_idx" ON "location_stock"("product_id");

-- El stock SOLO se descuenta del origen cuando el destino aprueba. Mientras
-- está "pendiente" sigue disponible sin restricción en el origen — no hay
-- reserva ni bloqueo. Rechazar no requiere revertir nada (nunca se movió).
CREATE TABLE IF NOT EXISTS "stock_transfers" (
  "id" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "from_location_id" TEXT NOT NULL REFERENCES "inventory_locations"("id"),
  "to_location_id" TEXT NOT NULL REFERENCES "inventory_locations"("id"),
  "requested_by_id" TEXT NOT NULL REFERENCES "users"("id"),
  "resolved_by_id" TEXT REFERENCES "users"("id"),
  "status" TEXT NOT NULL DEFAULT 'pendiente',
  "notes" TEXT,
  "reject_reason" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch()),
  "resolved_at" INTEGER
);
CREATE INDEX IF NOT EXISTS "transfers_company_idx" ON "stock_transfers"("company_id");
CREATE INDEX IF NOT EXISTS "transfers_from_idx" ON "stock_transfers"("from_location_id");
CREATE INDEX IF NOT EXISTS "transfers_to_idx" ON "stock_transfers"("to_location_id");
CREATE INDEX IF NOT EXISTS "transfers_status_idx" ON "stock_transfers"("status");

CREATE TABLE IF NOT EXISTS "stock_transfer_items" (
  "id" TEXT PRIMARY KEY,
  "transfer_id" TEXT NOT NULL REFERENCES "stock_transfers"("id") ON DELETE CASCADE,
  "product_id" TEXT NOT NULL REFERENCES "products"("id"),
  "product_code" TEXT NOT NULL,
  "product_name" TEXT NOT NULL,
  "unit" TEXT NOT NULL,
  "qty" REAL NOT NULL
);
CREATE INDEX IF NOT EXISTS "transfer_items_transfer_idx" ON "stock_transfer_items"("transfer_id");

-- Ventas, lecturas y cierres ahora pertenecen a una ubicación específica
-- (antes eran "de toda la empresa", como si solo existiera un inventario).
ALTER TABLE "sales" ADD COLUMN "location_id" TEXT REFERENCES "inventory_locations"("id");
ALTER TABLE "inventory_readings" ADD COLUMN "location_id" TEXT REFERENCES "inventory_locations"("id");
ALTER TABLE "cash_closings" ADD COLUMN "location_id" TEXT REFERENCES "inventory_locations"("id");

-- ── Datos existentes ─────────────────────────────────────────────────────
-- 1. Un almacén central por cada empresa ya existente.
INSERT INTO "inventory_locations" ("id", "company_id", "name", "type", "owner_user_id", "active")
SELECT 'loc_almacen_' || "id", "id", 'Almacén Central', 'almacen', NULL, 1
FROM "companies";

-- 2. El stock que ya tenía cada producto migra íntegro al almacén — nadie
--    pierde inventario con este cambio.
INSERT INTO "location_stock" ("id", "location_id", "product_id", "qty")
SELECT 'ls_' || p."id", 'loc_almacen_' || p."company_id", p."id", p."stock"
FROM "products" p;

-- 3. Una caja por cada cajero ya existente (activo o inactivo). Empiezan en
--    0 — el almacenista/admin les transfiere lo que necesiten desde ahora.
INSERT INTO "inventory_locations" ("id", "company_id", "name", "type", "owner_user_id", "active")
SELECT 'loc_caja_' || u."id", u."company_id", 'Caja - ' || u."name", 'caja', u."id", u."active"
FROM "users" u
WHERE u."role" = 'cajero';

-- 4. Lecturas/cierres históricos no tenían noción de ubicación porque este
--    sistema no existía; se asocian al almacén como mejor aproximación
--    retroactiva. Todo lo nuevo, de aquí en adelante, sí queda por caja.
UPDATE "inventory_readings" SET "location_id" = 'loc_almacen_' || "company_id" WHERE "location_id" IS NULL;
UPDATE "cash_closings" SET "location_id" = 'loc_almacen_' || "company_id" WHERE "location_id" IS NULL;
