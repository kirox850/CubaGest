import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { generateUUID } from "./jwt";
import type { AuthContext } from "../middleware/auth";
import {
  ensureLocationStockStmt,
  decrementStockStmt,
  incrementStockStmt,
  setStockStmt,
  recomputeProductStockStmt,
  stockMovementStmt,
  runBatch,
} from "./batch";

type DB = ReturnType<typeof drizzle>;

// ── ALMACÉN CENTRAL ──────────────────────────────────────────────────────────
// Toda empresa tiene UN almacén central. Es donde nace cada producto nuevo y
// donde vuelve el stock de las cajas. Antes no lo creaba el registro: una
// empresa nueva se quedaba sin almacén y el stock inicial se perdía en
// silencio (products.ts lo comprobaba con `if (almacen && ...)`).

export async function getAlmacenLocation(db: DB, companyId: string) {
  return db.select().from(schema.inventoryLocations)
    .where(and(
      eq(schema.inventoryLocations.companyId, companyId),
      eq(schema.inventoryLocations.type, "almacen"),
    ))
    .get();
}

// Igual que getAlmacenLocation pero exigiendo que esté ACTIVO. Para operar
// (vender, ajustar, sembrar stock) un almacén desactivado no sirve.
export async function getActiveAlmacenLocation(db: DB, companyId: string) {
  const row = await db.select().from(schema.inventoryLocations)
    .where(and(
      eq(schema.inventoryLocations.companyId, companyId),
      eq(schema.inventoryLocations.type, "almacen"),
      eq(schema.inventoryLocations.active, true),
    ))
    .get();
  return row ?? null;
}

/**
 * Devuelve el almacén central de la empresa, creándolo (o reactivándolo) si
 * no existe. Es idempotente y se puede llamar en cada operación que lo
 * necesite sin miedo a duplicar.
 */
export async function ensureAlmacenLocation(db: DB, companyId: string) {
  const existing = await getAlmacenLocation(db, companyId);
  if (existing) {
    if (!existing.active) {
      await db.update(schema.inventoryLocations)
        .set({ active: true })
        .where(eq(schema.inventoryLocations.id, existing.id));
      return { ...existing, active: true };
    }
    return existing;
  }

  const created = await db.insert(schema.inventoryLocations).values({
    id: generateUUID(),
    companyId,
    name: "Almacén Central",
    type: "almacen",
    ownerUserId: null,
    active: true,
  }).returning().get();

  return created;
}

export async function getCajaLocationForUser(db: DB, companyId: string, userId: string) {
  return db.select().from(schema.inventoryLocations)
    .where(and(
      eq(schema.inventoryLocations.companyId, companyId),
      eq(schema.inventoryLocations.ownerUserId, userId),
      eq(schema.inventoryLocations.type, "caja"),
    ))
    .get();
}

// "Mi propia ubicación" según el rol de quien hace la petición.
// admin NO tiene una ubicación propia fija — para acciones sobre una
// ubicación concreta, el admin debe indicarla explícitamente (locationId
// en el body/query), ya que admin ve y gestiona todas.
export async function resolveOwnLocation(db: DB, auth: AuthContext) {
  if (auth.role === "almacenista") return getActiveAlmacenLocation(db, auth.companyId);
  if (auth.role === "cajero") {
    const caja = await getCajaLocationForUser(db, auth.companyId, auth.userId);
    return caja && caja.active ? caja : null;
  }
  return null;
}

// Crea la caja de un cajero si todavía no la tiene (usuario nuevo, o un
// usuario existente al que le acaban de cambiar el rol a "cajero").
export async function ensureCajaLocation(db: DB, companyId: string, userId: string, userName: string) {
  const existing = await getCajaLocationForUser(db, companyId, userId);
  if (existing) {
    if (!existing.active) {
      await db.update(schema.inventoryLocations).set({ active: true }).where(eq(schema.inventoryLocations.id, existing.id));
    }
    return existing;
  }
  return db.insert(schema.inventoryLocations).values({
    id: generateUUID(),
    companyId,
    name: `Caja - ${userName}`,
    type: "caja",
    ownerUserId: userId,
  }).returning().get();
}

// Ubicación por id, SIEMPRE filtrada por empresa: es el patrón que se usa en
// ventas, sync, cierres y envíos para que nadie pueda operar sobre la caja de
// otra empresa ni sobre una ubicación inactiva.
export async function getCompanyLocation(db: DB, companyId: string, locationId: string) {
  return db.select().from(schema.inventoryLocations)
    .where(and(
      eq(schema.inventoryLocations.id, locationId),
      eq(schema.inventoryLocations.companyId, companyId),
    ))
    .get() ?? null;
}

export async function getActiveCompanyLocation(db: DB, companyId: string, locationId: string) {
  const row = await getCompanyLocation(db, companyId, locationId);
  return row && row.active ? row : null;
}

// Suma de location_stock de un producto en TODAS las ubicaciones de la
// empresa — se recalcula tras cualquier movimiento y queda en products.stock
// para dashboards/alertas a nivel de empresa (nunca se usa para vender).
export async function recomputeProductTotalStock(db: DB, productId: string) {
  const rows = await db.select().from(schema.locationStock).where(eq(schema.locationStock.productId, productId)).all();
  const total = rows.reduce((sum, r) => sum + Number(r.qty), 0);
  await db.update(schema.products).set({ stock: total, updatedAt: new Date() }).where(eq(schema.products.id, productId));
  return total;
}

export async function getOrCreateLocationStock(db: DB, locationId: string, productId: string) {
  const existing = await db.select().from(schema.locationStock)
    .where(and(eq(schema.locationStock.locationId, locationId), eq(schema.locationStock.productId, productId)))
    .get();
  if (existing) return existing;
  return db.insert(schema.locationStock).values({
    id: generateUUID(), locationId, productId, qty: 0,
  }).returning().get();
}

export async function getLocationStockQty(db: DB, locationId: string, productId: string): Promise<number> {
  const row = await db.select().from(schema.locationStock)
    .where(and(eq(schema.locationStock.locationId, locationId), eq(schema.locationStock.productId, productId)))
    .get();
  return row ? Number(row.qty) : 0;
}

// ── Ajuste de stock ATÓMICO ─────────────────────────────────────────────────
// Antes esto era leer qty → calcular en JS → escribir: dos cajeros descuentando
// a la vez del último stock podían dejar el inventario negativo. Ahora el
// descuento y la validación de "alcanza" ocurren en la misma sentencia
// (`UPDATE ... WHERE qty >= ?`), y el lote completo (descuento + total de
// empresa) va en UN batch, que es una transacción en D1.
export class StockInsufficientError extends Error {
  constructor(public readonly locationId: string, public readonly productId: string, public readonly requested: number) {
    super("Stock insuficiente en la ubicación de origen");
    this.name = "StockInsufficientError";
  }
}

export async function adjustLocationStockAtomic(
  env: Env,
  locationId: string,
  productId: string,
  delta: number
): Promise<{ changed: number; total: number }> {
  const rounded = Math.round(delta * 1000) / 1000;
  const statements: D1PreparedStatement[] = [ensureLocationStockStmt(env.DB, locationId, productId)];
  if (rounded < 0) statements.push(decrementStockStmt(env.DB, locationId, productId, Math.abs(rounded)));
  else statements.push(incrementStockStmt(env.DB, locationId, productId, rounded));
  statements.push(recomputeProductStockStmt(env.DB, productId));

  const [ensureChanged, stockChanged] = await runBatch(env.DB, statements);
  void ensureChanged;

  // El UPDATE es condicional: si cambió 0 filas es que en esa ubicación no
  // había stock suficiente (o la fila se acaba de crear con 0). No hay forma
  // de que el lote haya aplicado el descuento a medias: el batch es atómico.
  if (rounded < 0 && (stockChanged ?? 0) === 0) {
    throw new StockInsufficientError(locationId, productId, Math.abs(rounded));
  }

  const row = await env.DB
    .prepare(`SELECT qty FROM location_stock WHERE location_id = ? AND product_id = ?`)
    .bind(locationId, productId)
    .first<{ qty: number }>();
  return { changed: stockChanged ?? 0, total: Number(row?.qty ?? 0) };
}

// Fija el stock a un valor contado (cierre de inventario). Atómico y sin
// condición: el valor viene del conteo físico, no de una resta.
export async function setLocationStockAtomic(
  env: Env,
  locationId: string,
  productId: string,
  qty: number
): Promise<void> {
  await runBatch(env.DB, [
    ensureLocationStockStmt(env.DB, locationId, productId),
    setStockStmt(env.DB, locationId, productId, Math.round(qty * 1000) / 1000),
    recomputeProductStockStmt(env.DB, productId),
  ]);
}

// Cambia (delta puede ser negativo) el stock de un producto en una
// ubicación puntual, y recalcula el total de la empresa. Lanza error si el
// resultado sería negativo, salvo que se indique allowNegative.
// Implementado sobre el camino atómico: no hay ventana entre "leer" y
// "escribir" que otro request pueda aprovechar.
export async function adjustLocationStock(
  env: Env,
  locationId: string,
  productId: string,
  delta: number,
  opts: { allowNegative?: boolean } = {}
): Promise<number> {
  if (opts.allowNegative && delta < 0) {
    const statements: D1PreparedStatement[] = [
      ensureLocationStockStmt(env.DB, locationId, productId),
      incrementStockStmt(env.DB, locationId, productId, delta),
      recomputeProductStockStmt(env.DB, productId),
    ];
    await runBatch(env.DB, statements);
    const row = await env.DB
      .prepare(`SELECT qty FROM location_stock WHERE location_id = ? AND product_id = ?`)
      .bind(locationId, productId)
      .first<{ qty: number }>();
    return Number(row?.qty ?? 0);
  }
  const { total } = await adjustLocationStockAtomic(env, locationId, productId, delta);
  return total;
}

// ── Transferencia automática de stock ─────────────────────────────────────────
// Todas las filas del origen van al almacén y quedan registradas como un envío
// normal (aprobado automáticamente), para que se vea igual que cualquier otro
// movimiento en el historial y en la auditoría.
export async function buildReturnAllStockStatements(
  env: Env,
  params: {
    companyId: string;
    cajaLocationId: string;
    almacenLocationId: string;
    byUserId: string;
    reason: string;
    rows: { productId: string; qty: number; productCode: string; productName: string; unit: string }[];
  }
): Promise<{ transferId: string; statements: D1PreparedStatement[]; itemsReturned: number }> {
  const { companyId, cajaLocationId, almacenLocationId, byUserId, reason, rows } = params;
  const withStock = rows.filter((r) => Number(r.qty) > 0);
  const transferId = generateUUID();
  const statements: D1PreparedStatement[] = [
    env.DB.prepare(
      `INSERT INTO stock_transfers (id, company_id, from_location_id, to_location_id, requested_by_id, resolved_by_id, status, notes, resolved_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'aprobado', ?, unixepoch(), unixepoch())`
    ).bind(transferId, companyId, cajaLocationId, almacenLocationId, byUserId, byUserId, reason),
  ];

  for (const row of withStock) {
    statements.push(
      env.DB.prepare(
        `INSERT INTO stock_transfer_items (id, transfer_id, product_id, product_code, product_name, unit, qty)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(generateUUID(), transferId, row.productId, row.productCode, row.productName, row.unit, Number(row.qty))
    );
    statements.push(ensureLocationStockStmt(env.DB, almacenLocationId, row.productId));
    statements.push(decrementStockStmt(env.DB, cajaLocationId, row.productId, Number(row.qty)));
    statements.push(incrementStockStmt(env.DB, almacenLocationId, row.productId, Number(row.qty)));
    statements.push(
      stockMovementStmt(env.DB, {
        companyId, productId: row.productId, userId: byUserId, locationId: cajaLocationId,
        type: "salida", qty: Number(row.qty), reason: `Devolución al almacén (${reason})`,
      })
    );
    statements.push(recomputeProductStockStmt(env.DB, row.productId));
  }

  return { transferId, statements, itemsReturned: withStock.length };
}

// Devuelve TODO el stock restante de una caja al almacén de la empresa —
// usado al desactivar un cajero o cambiarle el rol. Queda registrado como
// una transferencia normal (aprobada automáticamente) para que se vea igual
// que cualquier otro envío en el historial/auditoría, con trazabilidad
// completa de qué se devolvió y por qué.
export async function returnAllStockToAlmacen(
  db: DB,
  env: Env,
  companyId: string,
  cajaLocationId: string,
  byUserId: string,
  reason: string
): Promise<{ transferId: string | null; itemsReturned: number }> {
  // ensureAlmacenLocation (y no un simple SELECT) para que devolver el stock de
  // una caja nunca falle por una empresa que se quedó sin almacén: si falta, se
  // crea aquí y el inventario no se queda flotando en una caja inactiva.
  const almacen = await ensureAlmacenLocation(db, companyId);
  if (!almacen) return { transferId: null, itemsReturned: 0 };

  const stockRows = await db.select().from(schema.locationStock)
    .where(eq(schema.locationStock.locationId, cajaLocationId)).all();
  const withStock = stockRows.filter((r) => Number(r.qty) > 0);
  if (withStock.length === 0) return { transferId: null, itemsReturned: 0 };

  const products = await db.select().from(schema.products)
    .where(eq(schema.products.companyId, companyId)).all();
  const productById = new Map(products.map((p) => [p.id, p]));

  const { transferId, statements, itemsReturned } = await buildReturnAllStockStatements(env, {
    companyId,
    cajaLocationId,
    almacenLocationId: almacen.id,
    byUserId,
    reason,
    rows: withStock.map((r) => {
      const p = productById.get(r.productId);
      return {
        productId: r.productId,
        qty: Number(r.qty),
        productCode: p?.code ?? "",
        productName: p?.name ?? "Producto eliminado",
        unit: p?.unit ?? "ud",
      };
    }),
  });

  await runBatch(env.DB, statements);
  return { transferId, itemsReturned };
}
