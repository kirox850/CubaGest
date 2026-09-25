-- Migration 0007 — Integridad P0 (ventas, stock, descuentos, cierres, sesiones)
--
-- SOLO cambios ADITIVOS. No se modifica ninguna migración anterior ni se
-- reescribe ninguna tabla existente: todo son columnas nuevas (nullable),
-- índices y triggers de validación. Los triggers hacen que D1 haga FALLAR la
-- sentencia (y por tanto todo el batch, que es una transacción) cuando una
-- operación dejaría el inventario o los contadores en un estado imposible.
-- Así el backend no depende de un "leer → calcular → escribir" que otro
-- request pueda pisar entre medio.

-- ── 1) Idempotencia de ventas (sync offline / reintentos) ────────────────────
-- El cliente genera un UUID por venta (clientSaleId). El índice único por
-- empresa hace que reenviar la misma venta NO cree una segunda factura: el
-- segundo intento choca contra el índice y el backend devuelve la venta ya
-- existente. Es NULL en las ventas viejas (online, sin idempotencia) porque en
-- SQLite un índice único normal trataría todos los NULL como duplicados.
ALTER TABLE "sales" ADD COLUMN "client_sale_id" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "sales_client_sale_idx"
  ON "sales" ("company_id", "client_sale_id")
  WHERE "client_sale_id" IS NOT NULL;

-- Descuento de nivel venta (los de línea ya están en sale_items.discount_id).
-- Sin esta columna una anulación no podía devolver el "uso" del descuento de
-- venta al contador, y se perdía un uso para siempre.
ALTER TABLE "sales" ADD COLUMN "discount_id" TEXT REFERENCES "discounts"("id");

-- ── 2) Ubicación en los movimientos de stock ─────────────────────────────────
-- Un movimiento sin ubicación no se puede auditar ni revertir: el stock vive
-- en location_stock, no en un único stock global. Las filas viejas (NULL) no
-- se tocan; a partir de aquí toda venta, anulación, envío, ajuste y cierre
-- escribe la ubicación donde ocurrió.
ALTER TABLE "stock_movements" ADD COLUMN "location_id" TEXT REFERENCES "inventory_locations"("id");
CREATE INDEX IF NOT EXISTS "sm_location_idx" ON "stock_movements"("location_id");

-- ── 3) Un cierre por lectura de apertura (uso único) ─────────────────────────
-- cash_closings queda ligado a su lectura inicial. El índice único parcial
-- sobre una columna nueva (NULL en los cierres históricos) impide confirmar
-- dos veces la misma apertura sin tener que borrar duplicados que ya existan
-- en producción — el histórico se respeta y la garantía es de aquí en adelante.
ALTER TABLE "cash_closings" ADD COLUMN "confirm_key" TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS "cash_closings_confirm_idx"
  ON "cash_closings" ("confirm_key")
  WHERE "confirm_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "cash_closings_location_idx" ON "cash_closings" ("location_id");

-- ── 4) Sesiones: refresh hasheado + rotación + revocación explícita ──────────
-- Antes se guardaba el refresh token en crudo y nunca se rotaba. Se añaden
-- columnas (nullable para no romper los tokens ya emitidos); cada refresh
-- renewal marca la sesión antigua y crea una nueva con su expiración.
ALTER TABLE "refresh_tokens" ADD COLUMN "token_hash" TEXT;
ALTER TABLE "refresh_tokens" ADD COLUMN "rotated_at" INTEGER;
ALTER TABLE "refresh_tokens" ADD COLUMN "revoked_at" INTEGER;
ALTER TABLE "refresh_tokens" ADD COLUMN "last_used_at" INTEGER;
ALTER TABLE "refresh_tokens" ADD COLUMN "device_label" TEXT;
-- Hash del token que SUSTITUYE a este (rotación de sesión). Permite seguir el
-- encadenamiento sin guardar el token en crudo.
ALTER TABLE "refresh_tokens" ADD COLUMN "rotated_to_hash" TEXT;
CREATE INDEX IF NOT EXISTS "refresh_tokens_hash_idx" ON "refresh_tokens" ("token_hash");
CREATE INDEX IF NOT EXISTS "refresh_tokens_user_idx" ON "refresh_tokens" ("user_id");

-- ── 5) Trigger: una línea de venta nunca deja el stock en negativo ───────────
-- Corre DENTRO de la misma transacción que el batch de la venta. Si la fila se
-- inserta cuando la ubicación no tiene stock suficiente, la sentencia falla y
-- D1 revierte TODO el batch (venta, líneas, movimientos, contadores): o se
-- guarda completa, o no se guarda nada. Dos ventas simultáneas del último
-- stock no pueden sobrevender.
CREATE TRIGGER IF NOT EXISTS "trg_sale_items_stock_guard"
BEFORE INSERT ON "sale_items"
FOR EACH ROW
WHEN NEW."qty" IS NULL OR NEW."qty" <= 0
  OR COALESCE((
       SELECT l."qty" FROM "location_stock" l
       WHERE l."location_id" = (SELECT s."location_id" FROM "sales" s WHERE s."id" = NEW."sale_id")
         AND l."product_id" = NEW."product_id"
     ), 0) < NEW."qty"
BEGIN
  SELECT RAISE(ABORT, 'stock insuficiente en la ubicacion de la venta');
END;

-- ── 6) Trigger: una venta anulada no se vuelve a anular ──────────────────────
-- El stock se devuelve UNA sola vez. El backend responde "idempotente" cuando
-- llega el segundo intento, pero la garantía final es de la base de datos.
CREATE TRIGGER IF NOT EXISTS "trg_sales_void_once"
BEFORE UPDATE OF "status" ON "sales"
FOR EACH ROW
WHEN OLD."status" = 'anulada' AND NEW."status" = 'anulada'
BEGIN
  SELECT RAISE(ABORT, 'la venta ya estaba anulada');
END;

-- ── 7) Trigger: los descuentos con límite de usos no se pasan ───────────────
-- El incremento de times_used es un UPDATE aritmético atómico dentro del
-- batch (nunca "leer y luego escribir"). Este trigger es la red de seguridad:
-- si dos cajeros canjean el último uso a la vez, el segundo batch aborta.
CREATE TRIGGER IF NOT EXISTS "trg_discounts_max_uses"
BEFORE UPDATE OF "times_used" ON "discounts"
FOR EACH ROW
WHEN NEW."times_used" > OLD."times_used"
  AND OLD."max_uses" IS NOT NULL
  AND NEW."times_used" > OLD."max_uses"
BEGIN
  SELECT RAISE(ABORT, 'descuento agotado');
END;

-- ── 8) Trigger: un envío se resuelve una sola vez ───────────────────────────
-- Aprobar/rechazar/cancelar dos veces el mismo envío movería el stock dos
-- veces. El estado solo puede salir de 'pendiente' una vez.
CREATE TRIGGER IF NOT EXISTS "trg_transfers_resolve_once"
BEFORE UPDATE OF "status" ON "stock_transfers"
FOR EACH ROW
WHEN OLD."status" <> 'pendiente'
  AND NEW."status" IN ('aprobado', 'rechazado', 'cancelado')
BEGIN
  SELECT RAISE(ABORT, 'el envio ya fue resuelto');
END;

-- ── 9) Backfill: empresas sin almacén o sin configuración ───────────────────
-- Las empresas creadas antes de este fix (o con el registro a medias) pueden
-- no tener "Almacén Central" ni fila en company_settings. Se rellenan aquí
-- para que ningún negocio quede sin almacén (todo producto nace en el almacén
-- y el stock inicial se siembra ahí). Si la empresa ya tiene uno, no se crea
-- un segundo almacén: el id sigue el mismo patrón que usó la migration 0003.
INSERT INTO "inventory_locations" ("id", "company_id", "name", "type", "owner_user_id", "active", "created_at")
SELECT 'loc_almacen_' || c."id", c."id", 'Almacén Central', 'almacen', NULL, 1, unixepoch()
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "inventory_locations" l WHERE l."company_id" = c."id" AND l."type" = 'almacen'
);

INSERT INTO "company_settings" ("company_id", "currencies", "rate_mode", "manual_rates", "eltoque_rates", "updated_at")
SELECT c."id", '["CUP"]', 'manual', '{}', '{}', unixepoch()
FROM "companies" c
WHERE NOT EXISTS (
  SELECT 1 FROM "company_settings" s WHERE s."company_id" = c."id"
);

-- El stock de empresa que quedó huérfano en products.stock (por ejemplo,
-- una venta vieja sobre un almacén borrado) vuelve al almacén, para que el
-- total de la empresa cuadre con la suma de las ubicaciones.
INSERT INTO "location_stock" ("id", "location_id", "product_id", "qty", "updated_at")
SELECT 'ls_' || p."id", 'loc_almacen_' || p."company_id", p."id", p."stock", unixepoch()
FROM "products" p
WHERE p."stock" > 0
  AND NOT EXISTS (SELECT 1 FROM "location_stock" ls WHERE ls."product_id" = p."id");

-- products.stock SIEMPRE es la suma de location_stock (columna calculada, ver
-- schema.ts). Recalculamos los totales para que el dashboard, las alertas de
-- stock bajo y el low-stock no muestren números que no existen en ninguna caja.
UPDATE "products" SET "stock" = (
  SELECT COALESCE(SUM(ls."qty"), 0)
  FROM "location_stock" ls
  WHERE ls."product_id" = "products"."id"
);
