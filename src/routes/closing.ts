import { Hono } from "hono";
import { eq, and, gte, lte, desc, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireRole } from "../middleware/roles";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { resolveOwnLocation, getLocationStockQty, getActiveCompanyLocation } from "../lib/locations";
import {
  auditStmt,
  runBatch,
  errorMessage,
  ensureLocationStockStmt,
  setStockStmt,
  recomputeProductStockStmt,
  stockMovementStmt,
} from "../lib/batch";

const closing = new Hono<{ Bindings: Env }>();

closing.use("*", authMiddleware);

// Ubicaciones que el usuario puede ver/operar en el módulo de cierre:
// admin ve todas (o filtra con ?locationId=), el resto solo la suya propia.
// El locationId que envía el admin se valida contra SU empresa: una caja de
// otra empresa no se responde, ni siquiera con datos vacíos.
async function resolveVisibleLocationIds(db: ReturnType<typeof drizzle>, auth: any, requestedLocationId?: string) {
  if (requestedLocationId) {
    const loc = await getActiveCompanyLocation(db, auth.companyId, requestedLocationId);
    return loc ? [loc.id] : [];
  }
  if (auth.role === "admin") {
    const all = await db.select({ id: schema.inventoryLocations.id }).from(schema.inventoryLocations)
      .where(eq(schema.inventoryLocations.companyId, auth.companyId)).all();
    return all.map((l) => l.id);
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

  const rows = await db.select().from(schema.inventoryReadings)
    .where(and(
      eq(schema.inventoryReadings.companyId, auth.companyId),
      inArray(schema.inventoryReadings.locationId, visibleIds)
    ))
    .orderBy(desc(schema.inventoryReadings.createdAt))
    .limit(50).all();

  return c.json({ ok: true, data: rows.slice(0, 20) });
});

// Toma una lectura de apertura para UNA ubicación puntual. Sigue siendo solo
// para admin (igual que antes) — ahora hay que indicar cuál ubicación.
closing.post("/readings", requireModule("cierre"), requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ locationId: string; notes?: string }>();
  if (!body.locationId) return c.json({ ok: false, error: "locationId es requerido" }, 400);

  const location = await getActiveCompanyLocation(db, auth.companyId, body.locationId);
  if (!location) return c.json({ ok: false, error: "Ubicación no encontrada o inactiva" }, 404);

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

// ¿Puede este usuario operar sobre ESTA ubicación?
// admin: sí, si la ubicación es de su empresa. cajero/almacenista: solo la
// suya. Cualquier otra cosa (incluida una ubicación de otra empresa) → no.
async function canAccessLocationId(db: ReturnType<typeof drizzle>, auth: any, locationId: string) {
  const loc = await getActiveCompanyLocation(db, auth.companyId, locationId);
  if (!loc) return false;
  if (auth.role === "admin") return true;
  const own = await resolveOwnLocation(db, auth);
  return own?.id === loc.id;
}

async function loadInitialReading(db: ReturnType<typeof drizzle>, auth: any, initialReadingId: string) {
  const reading = await db.select().from(schema.inventoryReadings)
    .where(and(
      eq(schema.inventoryReadings.id, initialReadingId),
      eq(schema.inventoryReadings.companyId, auth.companyId)
    )).get();
  if (!reading) return null;
  if (!reading.locationId || !(await canAccessLocationId(db, auth, reading.locationId))) {
    return null;
  }
  return reading;
}

closing.get("/preview/:initialReadingId", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const initialReadingId = c.req.param("initialReadingId");

  const initialReading = await loadInitialReading(db, auth, initialReadingId);
  if (!initialReading) {
    return c.json({ ok: false, error: "Lectura no encontrada o sin permisos sobre su ubicación" }, 404);
  }

  const periodStart = new Date(initialReading.createdAt!);
  const periodEnd = new Date();

  // Las ventas se filtran también por locationId — el cierre de cada cajero
  // solo cuenta SUS propias ventas, nunca las de otra caja.
  const sales = await db.select().from(schema.sales)
    .where(and(
      eq(schema.sales.companyId, auth.companyId),
      eq(schema.sales.locationId, initialReading.locationId),
      eq(schema.sales.status, "emitida"),
      gte(schema.sales.createdAt, periodStart),
      lte(schema.sales.createdAt, periodEnd),
    )).all();

  const saleIds = new Set(sales.map((s) => s.id));
  const allSaleItems = saleIds.size
    ? await db.select().from(schema.saleItems).where(inArray(schema.saleItems.saleId, Array.from(saleIds))).all()
    : [];
  const filteredSaleItems = allSaleItems.filter((si) => saleIds.has(si.saleId));

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
    const stockActual = await getLocationStockQty(db, initialReading.locationId!, p.id);
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
    if (!products.find((p) => p.id === ri.productId)) {
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

// POST /closing/confirm
// Reconciliación de INVENTARIO (el conteo físico ajusta el stock de la caja),
// no de caja física: el dinero se registra, no se cuenta.
closing.post("/confirm", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ initialReadingId: string; items: any[]; notes?: string }>().catch(() => null);
  if (!body?.initialReadingId) return c.json({ ok: false, error: "initialReadingId es requerido" }, 400);

  const initialReading = await loadInitialReading(db, auth, body.initialReadingId);
  if (!initialReading) {
    return c.json({ ok: false, error: "Lectura inicial no encontrada o sin permisos sobre su ubicación" }, 404);
  }
  const locationId = initialReading.locationId!;

  // ── Una lectura de apertura se confirma UNA vez ───────────────────────────
  // Antes se podía confirmar dos veces y se creaban dos cierres (y dos
  // ajustes de stock) sobre el mismo periodo. La garantía final es el índice
  // único parcial de cash_closings.confirm_key (migration 0007).
  const alreadyClosed = await db.select({ id: schema.cashClosings.id }).from(schema.cashClosings)
    .where(and(
      eq(schema.cashClosings.companyId, auth.companyId),
      eq(schema.cashClosings.confirmKey, initialReading.id)
    )).get();
  if (alreadyClosed) {
    return c.json(
      { ok: false, error: "Esta lectura de apertura ya se confirmó en un cierre anterior", code: "READING_ALREADY_CLOSED" },
      409
    );
  }

  // ── Conteo: solo productos de ESTA empresa ───────────────────────────────
  const submitted = Array.isArray(body.items) ? body.items : [];
  const submittedIds: string[] = [];
  for (const it of submitted) {
    const pid = it?.productId;
    if (typeof pid !== "string" || !pid) {
      return c.json({ ok: false, error: "Cada línea del conteo necesita un productId" }, 400);
    }
    const qty = Number(it.stockValidated);
    if (!Number.isFinite(qty) || qty < 0) {
      return c.json({ ok: false, error: `Cantidad contada inválida para ${pid}` }, 400);
    }
    submittedIds.push(pid);
  }

  if (submittedIds.length > 0) {
    // Ownership check: un productId de otra empresa (o inventado) se rechaza
    // ANTES de tocar nada. Antes esos IDs se colaban en el JSON del conteo y
    // cambiaban el stock de esta caja.
    const own = await db.select({ id: schema.products.id }).from(schema.products)
      .where(and(
        eq(schema.products.companyId, auth.companyId),
        inArray(schema.products.id, Array.from(new Set(submittedIds)))
      )).all();
    const ownIds = new Set(own.map((p) => p.id));
    const foreign = Array.from(new Set(submittedIds)).filter((id) => !ownIds.has(id));
    if (foreign.length > 0) {
      return c.json(
        { ok: false, error: `Algunos productos no pertenecen a tu empresa: ${foreign.join(", ")}`, code: "PRODUCT_NOT_IN_COMPANY" },
        400
      );
    }
  }

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

  const saleIds = new Set(sales.map((s) => s.id));
  const allSaleItems = saleIds.size
    ? await db.select().from(schema.saleItems).where(inArray(schema.saleItems.saleId, Array.from(saleIds))).all()
    : [];
  const filteredSaleItems = allSaleItems.filter((si) => saleIds.has(si.saleId));

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
  for (const item of submitted) validatedMap[item.productId] = Math.round(Number(item.stockValidated) * 1000) / 1000;

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
    const stockInitial = ri ? Number(ri.qty) : 0;
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
    .filter((i) => i.stockValidated >= 0)
    .map((i) => ({
      productId: i.productId,
      productCode: i.productCode,
      productName: i.productName,
      unit: i.unit,
      qty: i.stockValidated,
    }));

  const closingReadingId = generateUUID();
  const closingId = generateUUID();
  const totalSales = sales.length;
  const totalIncomeR = parseFloat(totalIncome.toFixed(2));
  const incomeEfectivoR = parseFloat(incomeEfectivo.toFixed(2));
  const incomeTransferenciaR = parseFloat(incomeTransferencia.toFixed(2));
  const hasShortage = closingItems.some((i) => i.shortage > 0.001);

  // ── Escritura atómica ────────────────────────────────────────────────────
  // Un solo batch: el cierre, su lectura final, el ajuste de stock de cada
  // producto contado y los totales de empresa. Si algo falla, no queda un
  // cierre a medias ni un stock movido sin registro.
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO cash_closings (id, company_id, location_id, closed_by_id, initial_reading_id,
                                  closing_reading_id, confirm_key, period_start, period_end,
                                  total_sales, total_income, income_efectivo, income_transferencia,
                                  items, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, unixepoch())`
    ).bind(
      closingId, auth.companyId, locationId, auth.userId, initialReading.id,
      closingReadingId, initialReading.id,
      // OJO: D1 solo acepta number|string|boolean|null|ArrayBuffer en bind().
      // Un Date lanzaría "Provided value cannot be bound..."; las columnas
      // period_start/period_end son INTEGER en segundos (unixepoch), igual que
      // created_at de las migraciones.
      Math.floor(periodStart.getTime() / 1000), Math.floor(periodEnd.getTime() / 1000),
      totalSales, totalIncomeR, incomeEfectivoR, incomeTransferenciaR,
      JSON.stringify(closingItems), (body.notes || "").trim() || null
    ),
    c.env.DB.prepare(
      `INSERT INTO inventory_readings (id, company_id, location_id, taken_by_id, type, notes, items, created_at)
       VALUES (?, ?, ?, ?, 'cierre', ?, ?, unixepoch())`
    ).bind(
      closingReadingId, auth.companyId, locationId, auth.userId,
      "Generada automaticamente al cierre", JSON.stringify(closingReadingItems)
    ),
  ];

  for (const item of closingItems) {
    if (validatedMap[item.productId] === undefined) continue;
    const current = await getLocationStockQty(db, locationId, item.productId);
    const delta = validatedMap[item.productId] - current;
    if (Math.abs(delta) < 0.0005) continue;
    stmts.push(
      ensureLocationStockStmt(c.env.DB, locationId, item.productId),
      setStockStmt(c.env.DB, locationId, item.productId, validatedMap[item.productId]),
      stockMovementStmt(c.env.DB, {
        companyId: auth.companyId,
        productId: item.productId,
        userId: auth.userId,
        locationId,
        type: "ajuste",
        qty: delta,
        reason: "Cierre de inventario (conteo físico)",
      }),
      recomputeProductStockStmt(c.env.DB, item.productId)
    );
  }

  stmts.push(
    auditStmt(c.env, {
      companyId: auth.companyId, userId: auth.userId,
      action: "closing.confirm", entity: "cash_closing", entityId: closingId,
      detail: {
        locationId, totalSales, totalIncome: totalIncomeR, hasShortage,
        shortageItems: closingItems.filter((i) => i.shortage > 0.001).map((i) => ({ product: i.productName, shortage: i.shortage })),
      },
      ip: getClientIp(c),
    })
  );

  try {
    await runBatch(c.env.DB, stmts);
  } catch (err) {
    const msg = errorMessage(err);
    console.error("closing/confirm: batch falló y se revirtió:", msg);
    if (/cash_closings\.confirm_key/i.test(msg)) {
      return c.json(
        { ok: false, error: "Esta lectura de apertura ya se confirmó en un cierre anterior", code: "READING_ALREADY_CLOSED" },
        409
      );
    }
    return c.json({ ok: false, error: "No se pudo registrar el cierre. Inténtalo de nuevo.", code: "CLOSING_COMMIT_FAILED" }, 503);
  }

  const closingRecord = await db.select().from(schema.cashClosings)
    .where(eq(schema.cashClosings.id, closingId)).get();
  return c.json({ ok: true, data: closingRecord }, 201);
});

closing.get("/", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { locationId } = c.req.query();
  const visibleIds = await resolveVisibleLocationIds(db, auth, locationId);
  if (visibleIds.length === 0) return c.json({ ok: true, data: [] });

  const rows = await db.select().from(schema.cashClosings)
    .where(and(
      eq(schema.cashClosings.companyId, auth.companyId),
      inArray(schema.cashClosings.locationId, visibleIds)
    ))
    .orderBy(desc(schema.cashClosings.createdAt))
    .limit(50).all();

  return c.json({ ok: true, data: rows });
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
