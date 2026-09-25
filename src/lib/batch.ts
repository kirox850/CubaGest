// Primitivas SQL para escribir en D1 de forma atómica.
//
// ── Qué garantiza realmente D1 (y qué NO) ───────────────────────────────────
// D1 expone `db.batch([...])`: una lista de sentencias preparadas que se
// ejecutan en una TRANSACCIÓN. Si una sola sentencia falla (restricción NOT
// NULL, CHECK, FK, UNIQUE, o un trigger con RAISE(ABORT)), TODO el batch se
// revierte. Eso es lo que usamos en ventas, anulaciones, cierres y envíos: o se
// escribe el grupo completo, o no se escribe nada.
//
// Lo que D1 NO ofrece y por eso evitamos:
//   - No hay transacción interactiva con rollback manual: no existe
//     BEGIN/COMMIT/ROLLBACK desde el código.
//   - No hay SELECT ... FOR UPDATE ni bloqueo explícito entre dos sentencias
//     sueltas. Por eso NUNCA hacemos "leer el stock, calcular en JS, escribir":
//     dos cajeros podrían leer el mismo valor. Escribimos con SQL aritmético
//     (`qty = qty - ?`) y con UPDATE condicional (`WHERE qty >= ?`).
//   - D1 serializa las escrituras de toda la base, así que dos batches no se
//     intercalan a mitad de ejecución; la garantía es "el batch entero entra o
//     no entra", no "estas dos ventas están bloqueadas".
//   - El UNIQUE de (company_id, invoice_number) y de (company_id,
//     client_sale_id) es la barrera final contra facturas duplicadas; los
//     triggers de la migration 0007 son la barrera contra stock negativo,
//     sobre-descuentos, doble anulación y doble resolución de un envío.

import { generateUUID } from "./jwt";

type D1DB = D1Database;

/** ¿Este error de D1 es una violación de restricción (y por tanto un rollback)? */
export function isConstraintError(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err ?? "");
  return /UNIQUE constraint failed|CHECK constraint failed|FOREIGN KEY constraint failed|NOT NULL constraint failed|constraint failed|ABORT:/.test(msg);
}

/** ¿El error es específicamente el índice único de idempotencia de la venta? */
export function isClientSaleConflict(err: unknown): boolean {
  const msg = (err as { message?: string } | null)?.message ?? String(err ?? "");
  return msg.includes("sales.company_id, sales.client_sale_id");
}

export function errorMessage(err: unknown): string {
  return (err as { message?: string } | null)?.message ?? String(err ?? "");
}

/**
 * Ejecuta un batch y devuelve los `meta.changes` de cada sentencia.
 * Lanza el error original de D1 si algo falla (con el batch revertido).
 */
export async function runBatch(
  db: D1DB,
  statements: D1PreparedStatement[]
): Promise<number[]> {
  if (statements.length === 0) return [];
  const results = await db.batch(statements);
  return results.map((r) => Number(r?.meta?.changes ?? 0));
}

/** Fila de location_stock para (ubicación, producto), creándola si falta. */
export function ensureLocationStockStmt(
  db: D1DB, locationId: string, productId: string
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO location_stock (id, location_id, product_id, qty, updated_at)
       VALUES (?, ?, ?, 0, unixepoch())
       ON CONFLICT(location_id, product_id) DO NOTHING`
    )
    .bind(generateUUID(), locationId, productId);
}

/**
 * Descuenta stock SOLO si alcanza. El `WHERE qty >= ?` hace la comprobación y
 * la escritura en la misma sentencia: si no alcanza, cambia 0 filas y el
 * trigger de sale_items (0007) revierte el batch completo.
 */
export function decrementStockStmt(
  db: D1DB, locationId: string, productId: string, qty: number
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE location_stock
          SET qty = ROUND(qty - ?, 3), updated_at = unixepoch()
        WHERE location_id = ? AND product_id = ? AND qty >= ?`
    )
    .bind(qty, locationId, productId, qty);
}

/** Devuelve stock (anulación de venta, ajuste de cierre, entrada). */
export function incrementStockStmt(
  db: D1DB, locationId: string, productId: string, qty: number
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE location_stock
          SET qty = ROUND(qty + ?, 3), updated_at = unixepoch()
        WHERE location_id = ? AND product_id = ?`
    )
    .bind(qty, locationId, productId);
}

/** Fija el stock de una ubicación al valor contado en un cierre. */
export function setStockStmt(
  db: D1DB, locationId: string, productId: string, qty: number
): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE location_stock
          SET qty = ?, updated_at = unixepoch()
        WHERE location_id = ? AND product_id = ?`
    )
    .bind(qty, locationId, productId);
}

/** products.stock es SIEMPRE la suma de location_stock (columna calculada). */
export function recomputeProductStockStmt(db: D1DB, productId: string): D1PreparedStatement {
  return db
    .prepare(
      `UPDATE products
          SET stock = (SELECT COALESCE(SUM(qty), 0) FROM location_stock WHERE product_id = ?),
              updated_at = unixepoch()
        WHERE id = ?`
    )
    .bind(productId, productId);
}

/** Movimiento de inventario con la ubicación donde ocurrió (columna 0007). */
export function stockMovementStmt(
  db: D1DB,
  row: {
    companyId: string;
    productId: string;
    userId: string | null;
    locationId: string | null;
    type: "entrada" | "salida" | "venta" | "ajuste";
    qty: number;
    reason: string | null;
  }
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO stock_movements (id, company_id, product_id, user_id, location_id, type, qty, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
    )
    .bind(
      generateUUID(), row.companyId, row.productId, row.userId, row.locationId,
      row.type, row.qty, row.reason
    );
}

/**
 * Consumo de un descuento. Es aritmético SQL (nunca leer→escribir) y el
 * trigger trg_discounts_max_uses (0007) aborta el batch si el descuento se
 * quedó sin usos en la misma transacción.
 */
export function consumeDiscountStmt(db: D1DB, discountId: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE discounts SET times_used = times_used + 1 WHERE id = ?`)
    .bind(discountId);
}

/** Devuelve un uso al anular una venta (nunca baja de 0). */
export function releaseDiscountStmt(db: D1DB, discountId: string): D1PreparedStatement {
  return db
    .prepare(`UPDATE discounts SET times_used = MAX(times_used - 1, 0) WHERE id = ?`)
    .bind(discountId);
}

/**
 * Renglón de auditoría dentro de un batch: si la venta no se guarda, tampoco
 * queda un log que diga que se guardó.
 */
export function auditStmt(
  db: D1DB,
  row: {
    companyId: string;
    userId: string | null;
    action: string;
    entity: string;
    entityId?: string | null;
    detail?: unknown;
    ip?: string | null;
  }
): D1PreparedStatement {
  const detail =
    typeof row.detail === "string"
      ? row.detail
      : row.detail == null
        ? null
        : JSON.stringify(row.detail);
  return db
    .prepare(
      `INSERT INTO audit_logs (id, company_id, user_id, action, entity, entity_id, detail, ip, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
    )
    .bind(
      generateUUID(), row.companyId, row.userId, row.action, row.entity,
      row.entityId ?? null, detail, row.ip ?? null
    );
}
