import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { generateUUID } from "./jwt";
import type { AuthContext } from "../middleware/auth";

type DB = ReturnType<typeof drizzle>;

export async function getAlmacenLocation(db: DB, companyId: string) {
  return db.select().from(schema.inventoryLocations)
    .where(and(eq(schema.inventoryLocations.companyId, companyId), eq(schema.inventoryLocations.type, "almacen")))
    .get();
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
  if (auth.role === "almacenista") return getAlmacenLocation(db, auth.companyId);
  if (auth.role === "cajero") return getCajaLocationForUser(db, auth.companyId, auth.userId);
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
}// Cambia (delta puede ser negativo) el stock de un producto en una
// ubicación puntual, y recalcula el total de la empresa. Lanza error si el
// resultado sería negativo, salvo que se indique allowNegative.
export async function adjustLocationStock(
  db: DB,
  locationId: string,
  productId: string,
  delta: number,
  opts: { allowNegative?: boolean } = {}
): Promise<number> {
  const row = await getOrCreateLocationStock(db, locationId, productId);
  const newQty = parseFloat((Number(row.qty) + delta).toFixed(3));
  if (newQty < 0 && !opts.allowNegative) {
    throw new Error("Stock insuficiente en la ubicación de origen");
  }
  await db.update(schema.locationStock).set({ qty: newQty, updatedAt: new Date() }).where(eq(schema.locationStock.id, row.id));
  await recomputeProductTotalStock(db, productId);
  return newQty;
}

// Devuelve TODO el stock restante de una caja al almacén de la empresa —
// usado al desactivar un cajero o cambiarle el rol. Queda registrado como
// una transferencia normal (aprobada automáticamente) para que se vea igual
// que cualquier otro envío en el historial/auditoría, con trazabilidad
// completa de qué se devolvió y por qué.
export async function returnAllStockToAlmacen(
  db: DB,
  companyId: string,
  cajaLocationId: string,
  byUserId: string,
  reason: string
): Promise<{ transferId: string | null; itemsReturned: number }> {
  const almacen = await getAlmacenLocation(db, companyId);
  if (!almacen) return { transferId: null, itemsReturned: 0 };

  const stockRows = await db.select().from(schema.locationStock)
    .where(eq(schema.locationStock.locationId, cajaLocationId)).all();
  const withStock = stockRows.filter(r => Number(r.qty) > 0);
  if (withStock.length === 0) return { transferId: null, itemsReturned: 0 };

  const transfer = await db.insert(schema.stockTransfers).values({
    id: generateUUID(),
    companyId,
    fromLocationId: cajaLocationId,
    toLocationId: almacen.id,
    requestedById: byUserId,
    resolvedById: byUserId,
    status: "aprobado",
    notes: reason,
    resolvedAt: new Date(),
  }).returning().get();

  for (const row of withStock) {
    const product = await db.select().from(schema.products).where(eq(schema.products.id, row.productId)).get();
    if (!product) continue;
    await db.insert(schema.stockTransferItems).values({
      id: generateUUID(),
      transferId: transfer.id,
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      unit: product.unit,
      qty: Number(row.qty),
    });
    await adjustLocationStock(db, cajaLocationId, product.id, -Number(row.qty));
    await adjustLocationStock(db, almacen.id, product.id, Number(row.qty), { allowNegative: true });
  }

  return { transferId: transfer.id, itemsReturned: withStock.length };
}
