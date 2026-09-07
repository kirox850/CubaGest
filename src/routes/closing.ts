import { Hono } from "hono";
import { eq, and, gte, lte, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireRole } from "../middleware/roles";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { resolveOwnLocation, getLocationStockQty, adjustLocationStock } from "../lib/locations";

const closing = new Hono<{ Bindings: Env }>();

closing.use("*", authMiddleware);

// Ubicaciones que el usuario puede ver/operar en el módulo de cierre:
// admin ve todas (o filtra con ?locationId=), el resto solo la suya propia.
async function resolveVisibleLocationIds(db: ReturnType<typeof drizzle>, auth: any, requestedLocationId?: string) {
  if (auth.role === "admin") {
    if (requestedLocationId) return [requestedLocationId];
    const all = await db.select({ id: schema.inventoryLocations.id }).from(schema.inventoryLocations)
      .where(eq(schema.inventoryLocations.companyId, auth.companyId)).all();
    return all.map(l => l.id);
  }
  const own = await resolveOwnLocation(db, auth);
  return own ? [own.id] : [];
}

closing.get("/readings", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { locationId } = c.req.query();
  const visibleIds = await resolveVisibleLocationIds(db, auth, locationId);
  if (visibleIds.length === 0) return c.json({ ok: true, data: [] });

  const all: (typeof schema.inventoryReadings.$inferSelect)[] = [];
  for (const locId of visibleIds) {
    const rows = await db.select().from(schema.inventoryReadings)
      .where(and(eq(schema.inventoryReadings.companyId, auth.companyId), eq(schema.inventoryReadings.locationId, locId)))
      .orderBy(desc(schema.inventoryReadings.createdAt))
      .limit(20).all();
    all.push(...rows);
  }
  all.sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());
  return c.json({ ok: true, data: all.slice(0, 20) });
});

// Toma una lectura de apertura para UNA ubicación puntual. Sigue siendo solo
// para admin (igual que antes) — ahora hay que indicar cuál ubicación.
closing.post("/readings", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ locationId: string; notes?: string }>();
  if (!body.locationId) return c.json({ ok: false, error: "locationId es requerido" }, 400);

  const location = await db.select().from(schema.inventoryLocations)
    .where(and(eq(schema.inventoryLocations.id, body.locationId), eq(schema.inventoryLocations.companyId, auth.companyId))).get();
  if (!location) return c.json({ ok: false, error: "Ubicación no encontrada" }, 404);

  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).all();

  const items = [];
  for (const p of products) {
    const qty = await getLocationStockQty(db, location.id, p.id);
    items.push({ productId: p.id, productCode: p.code, productName: p.name, unit: p.unit, qty });
  }

  const reading = await db.insert(schema.inventoryReadings).values({
    id: generateUUID(),
    companyId: auth.companyId,
    locationId: location.id,
    takenById: auth.userId,
    type: "apertura",
    notes: body.notes || null,
    items,
  }).returning().get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "closing.take_reading", entity: "inventory_reading", entityId: reading.id,
    detail: { locationName: location.name },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: reading }, 201);
});

async function canAccessLocationId(db: ReturnType<typeof drizzle>, auth: any, locationId: string) {
  if (auth.role === "admin") return true;
  const own = await resolveOwnLocation(db, auth);
  return own?.id === locationId;
}

closing.get("/preview/:initialReadingId", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const initialReadingId = c.req.param("initialReadingId");

  const initialReading = await db.select().from(schema.inventoryReadings)
    .where(and(eq(schema.inventoryReadings.id, initialReadingId), eq(schema.inventoryReadings.companyId, auth.companyId))).get();
  if (!initialReading) return c.json({ ok: false, error: "Lectura no encontrada" }, 404);
  if (!initialReading.locationId || !(await canAccessLocationId(db, auth, initialReading.locationId))) {
    return c.json({ ok: false, error: "No tiene permisos sobre la ubicación de esta lectura" }, 403);
  }

  const periodStart = new Date(initialReading.createdAt!);
  const periodEnd = new Date();

  // FIX clave: las ventas se filtran también por locationId — el cierre de
  // cada cajero solo cuenta SUS propias ventas, nunca las de otra caja.
  const sales = await db.select().from(schema.sales)
    .where(and(
      eq(schema.sales.companyId, auth.companyId),
      eq(schema.sales.locationId, initialReading.locationId),
      eq(schema.sales.status, "emitida"),
      gte(schema.sales.createdAt, periodStart),
      lte(schema.sales.createdAt, periodEnd),
    )).all();

  const allSaleItems = await db.select().from(schema.saleItems).all();
  const filteredSaleItems = allSaleItems.filter(si => sales.some(s => s.id === si.saleId));

  const soldMap: Record<string, number> = {};
  const incomeMap: Record<string, number> = {};
  let totalIncome = 0;
  let incomeEfectivo = 0;
  let incomeTransferencia = 0;
  for (const sale of sales) {
    const amount = Number(sale.total);
    totalIncome += amount;
    if (sale.payMethod === "efectivo") incomeEfectivo += amount;
    else if (sale.payMethod === "transferencia") incomeTransferencia += amount;
  }
  for (const item of filteredSaleItems) {
    if (!item.productId) continue;
    soldMap[item.productId] = (soldMap[item.productId] || 0) + Number(item.qty);
    incomeMap[item.productId] = (incomeMap[item.productId] || 0) + Number(item.total);
  }

  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).all();

  const readingMap: Record<string, any> = {};
  for (const item of initialReading.items as any[]) readingMap[item.productId] = item;

  const resultItems: any[] = [];
  for (const p of products) {
    const ri = readingMap[p.id];
    const stockInitial = ri ? ri.qty : 0;
    const stockSold = soldMap[p.id] || 0;
    const stockExpected = parseFloat((stockInitial - stockSold).toFixed(3));
    // Stock ACTUAL en ESTA ubicación puntual, no el total de la empresa.
    const stockActual = await getLocationStockQty(db, initialReading.locationId, p.id);
    const shortage = parseFloat((stockExpected - stockActual).toFixed(3));
    resultItems.push({
      productId: p.id,
      productCode: p.code,
      productName: p.name,
      unit: p.unit,
      price: Number(p.price),
      stockInitial,
      stockSold,
      stockExpected,
      stockValidated: stockActual,
      shortage,
      income: parseFloat((incomeMap[p.id] || 0).toFixed(2)),
    });
  }
  for (const ri of initialReading.items as any[]) {
    if (!products.find(p => p.id === ri.productId)) {
      const stockSold = soldMap[ri.productId] || 0;
      const stockExpected = parseFloat((ri.qty - stockSold).toFixed(3));
      resultItems.push({
        productId: ri.productId,
        productCode: ri.productCode,
        productName: ri.productName + " (inactivo)",
        unit: ri.unit,
        price: 0,
        stockInitial: ri.qty,
        stockSold,
        stockExpected,
        stockValidated: 0,
        shortage: stockExpected,
        income: parseFloat((incomeMap[ri.productId] || 0).toFixed(2)),
      });
    }
  }

  return c.json({
    ok: true,
    data: {
      initialReading: { id: initialReading.id, type: initialReading.type, createdAt: initialReading.createdAt, notes: initialReading.notes, locationId: initialReading.locationId },
      periodStart,
      periodEnd,
      totalSales: sales.length,
      totalIncome: parseFloat(totalIncome.toFixed(2)),
      incomeEfectivo: parseFloat(incomeEfectivo.toFixed(2)),
      incomeTransferencia: parseFloat(incomeTransferencia.toFixed(2)),
      items: resultItems,
    },
  });
});

closing.post("/confirm", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ initialReadingId: string; items: any[]; notes?: string }>();
  const { initialReadingId, items, notes } = body;

  const initialReading = await db.select().from(schema.inventoryReadings)
    .where(and(eq(schema.inventoryReadings.id, initialReadingId), eq(schema.inventoryReadings.companyId, auth.companyId))).get();
  if (!initialReading) return c.json({ ok: false, error: "Lectura inicial no encontrada" }, 404);
  if (!initialReading.locationId || !(await canAccessLocationId(db, auth, initialReading.locationId))) {
    return c.json({ ok: false, error: "No tiene permisos sobre la ubicación de esta lectura" }, 403);
  }
  const locationId = initialReading.locationId;

  const periodStart = new Date(initialReading.createdAt!);
  const periodEnd = new Date();

  const sales = await db.select().from(schema.sales)
    .where(and(
      eq(schema.sales.companyId, auth.companyId),
      eq(schema.sales.locationId, locationId),
      eq(schema.sales.status, "emitida"),
      gte(schema.sales.createdAt, periodStart),
      lte(schema.sales.createdAt, periodEnd),
    )).all();

  const allSaleItems = await db.select().from(schema.saleItems).all();
  const filteredSaleItems = allSaleItems.filter(si => sales.some(s => s.id === si.saleId));

  const soldMap: Record<string, number> = {};
  const incomeMap: Record<string, number> = {};
  let totalIncome = 0;
  let incomeEfectivo = 0;
  let incomeTransferencia = 0;
  for (const sale of sales) {
    const amount = Number(sale.total);
    totalIncome += amount;
    if (sale.payMethod === "efectivo") incomeEfectivo += amount;
    else if (sale.payMethod === "transferencia") incomeTransferencia += amount;
  }
  for (const item of filteredSaleItems) {
    if (!item.productId) continue;
    soldMap[item.productId] = (soldMap[item.productId] || 0) + Number(item.qty);
    incomeMap[item.productId] = (incomeMap[item.productId] || 0) + Number(item.total);
  }

  const validatedMap: Record<string, number> = {};
  for (const item of items) validatedMap[item.productId] = parseFloat(item.stockValidated);

  const readingMap: Record<string, any> = {};
  for (const ri of initialReading.items as any[]) readingMap[ri.productId] = ri;

  const allProductIds = new Set([
    ...Object.keys(readingMap),
    ...Object.keys(soldMap),
    ...Object.keys(validatedMap),
  ]);

  const closingItems: any[] = [];
  for (const pid of allProductIds) {
    const ri = readingMap[pid];
    const stockInitial = ri ? ri.qty : 0;
    const stockSold = soldMap[pid] || 0;
    const stockExpected = parseFloat((stockInitial - stockSold).toFixed(3));
    const stockValidated = validatedMap[pid] !== undefined ? validatedMap[pid] : stockExpected;
    const shortage = parseFloat((stockExpected - stockValidated).toFixed(3));
    closingItems.push({
      productId: pid,
      productCode: ri?.productCode || "",
      productName: ri?.productName || "",
      unit: ri?.unit || "ud",
      price: 0,
      stockInitial,
      stockSold,
      stockExpected,
      stockValidated,
      shortage,
      income: parseFloat((incomeMap[pid] || 0).toFixed(2)),
    });
  }

  const closingReadingItems = closingItems
    .filter(i => i.stockValidated >= 0)
    .map(i => ({
      productId: i.productId,
      productCode: i.productCode,
      productName: i.productName,
      unit: i.unit,
      qty: i.stockValidated,
    }));

  // Esta nueva lectura "cierre" queda como referencia para el PRÓXIMO
  // cierre de esta misma ubicación (orden desc en /readings la trae primero).
  const closingReading = await db.insert(schema.inventoryReadings).values({
    id: generateUUID(),
    companyId: auth.companyId,
    locationId,
    takenById: auth.userId,
    type: "cierre",
    notes: "Generada automaticamente al cierre",
    items: closingReadingItems,
  }).returning().get();

  // El conteo físico ajusta el stock de ESTA ubicación puntual (no el
  // global) — y recalcula el total de la empresa automáticamente.
  for (const item of closingItems) {
    if (validatedMap[item.productId] === undefined) continue;
    const current = await getLocationStockQty(db, locationId, item.productId);
    const delta = validatedMap[item.productId] - current;
    if (delta !== 0) {
      await adjustLocationStock(db, locationId, item.productId, delta, { allowNegative: true });
    }
  }

  const closingRecord = await db.insert(schema.cashClosings).values({
    id: generateUUID(),
    companyId: auth.companyId,
    locationId,
    closedById: auth.userId,
    initialReadingId: initialReading.id,
    closingReadingId: closingReading.id,
    periodStart,
    periodEnd,
    totalSales: sales.length,
    totalIncome: parseFloat(totalIncome.toFixed(2)),
    incomeEfectivo: parseFloat(incomeEfectivo.toFixed(2)),
    incomeTransferencia: parseFloat(incomeTransferencia.toFixed(2)),
    items: closingItems,
    notes: notes || null,
  }).returning().get();

  const hasShortage = closingItems.some(i => i.shortage > 0.001);
  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "closing.confirm", entity: "cash_closing", entityId: closingRecord.id,
    detail: {
      locationId, totalSales: sales.length, totalIncome: closingRecord.totalIncome,
      hasShortage, shortageItems: closingItems.filter(i => i.shortage > 0.001).map(i => ({ product: i.productName, shortage: i.shortage })),
    },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: closingRecord }, 201);
});

closing.get("/", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { locationId } = c.req.query();
  const visibleIds = await resolveVisibleLocationIds(db, auth, locationId);
  if (visibleIds.length === 0) return c.json({ ok: true, data: [] });

  const all: (typeof schema.cashClosings.$inferSelect)[] = [];
  for (const locId of visibleIds) {
    const rows = await db.select().from(schema.cashClosings)
      .where(and(eq(schema.cashClosings.companyId, auth.companyId), eq(schema.cashClosings.locationId, locId)))
      .orderBy(desc(schema.cashClosings.createdAt))
      .limit(50).all();
    all.push(...rows);
  }
  all.sort((a, b) => new Date(b.createdAt!).getTime() - new Date(a.createdAt!).getTime());
  return c.json({ ok: true, data: all.slice(0, 50) });
});

closing.get("/:id", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const row = await db.select().from(schema.cashClosings)
    .where(and(eq(schema.cashClosings.id, id), eq(schema.cashClosings.companyId, auth.companyId))).get();
  if (!row) return c.json({ ok: false, error: "Cierre no encontrado" }, 404);
  if (!row.locationId || !(await canAccessLocationId(db, auth, row.locationId))) {
    return c.json({ ok: false, error: "No tiene permisos sobre la ubicación de este cierre" }, 403);
  }
  return c.json({ ok: true, data: row });
});

export default closing;
