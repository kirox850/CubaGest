import { Hono } from "hono";
import { eq, and, or, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { resolveOwnLocation, adjustLocationStock, getLocationStockQty } from "../lib/locations";

const transfers = new Hono<{ Bindings: Env }>();

transfers.use("*", authMiddleware);

async function attachItems(db: ReturnType<typeof drizzle>, transfer: typeof schema.stockTransfers.$inferSelect) {
  const items = await db.select().from(schema.stockTransferItems)
    .where(eq(schema.stockTransferItems.transferId, transfer.id)).all();
  return { ...transfer, items };
}

// POST /transfers — crear un envío. El origen es la ubicación propia del
// usuario (almacenista → almacén, cajero → su caja); admin debe indicar
// fromLocationId explícitamente porque no tiene una ubicación propia fija.
// NO se toca el stock aquí — sigue disponible en el origen hasta que el
// destino apruebe.
transfers.post("/", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{
    fromLocationId?: string;
    toLocationId: string;
    items: { productId: string; qty: number }[];
    notes?: string;
  }>();

  let fromLocation;
  if (auth.role === "admin" && body.fromLocationId) {
    fromLocation = await db.select().from(schema.inventoryLocations)
      .where(and(eq(schema.inventoryLocations.id, body.fromLocationId), eq(schema.inventoryLocations.companyId, auth.companyId))).get();
  } else {
    fromLocation = await resolveOwnLocation(db, auth);
  }
  if (!fromLocation) return c.json({ ok: false, error: "No se pudo determinar la ubicación de origen" }, 400);
  if (!fromLocation.active) return c.json({ ok: false, error: "La ubicación de origen está inactiva" }, 400);

  if (!body.toLocationId) return c.json({ ok: false, error: "toLocationId es requerido" }, 400);
  if (body.toLocationId === fromLocation.id) return c.json({ ok: false, error: "El origen y destino no pueden ser la misma ubicación" }, 400);

  const toLocation = await db.select().from(schema.inventoryLocations)
    .where(and(eq(schema.inventoryLocations.id, body.toLocationId), eq(schema.inventoryLocations.companyId, auth.companyId))).get();
  if (!toLocation) return c.json({ ok: false, error: "Ubicación de destino no encontrada" }, 404);
  if (!toLocation.active) return c.json({ ok: false, error: "La ubicación de destino está inactiva" }, 400);

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ ok: false, error: "El envío debe tener al menos un producto" }, 400);
  }

  const itemRows: (typeof schema.stockTransferItems.$inferInsert)[] = [];
  for (const it of body.items) {
    const qty = Number(it.qty);
    if (!qty || qty <= 0) return c.json({ ok: false, error: "Cantidad inválida en uno de los productos" }, 400);
    const product = await db.select().from(schema.products)
      .where(and(eq(schema.products.id, it.productId), eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).get();
    if (!product) return c.json({ ok: false, error: `Producto ${it.productId} no encontrado` }, 404);

    // Chequeo informativo al crear — no bloquea de forma definitiva, porque
    // el stock del origen puede seguir moviéndose mientras el envío está
    // pendiente. El chequeo que de verdad cuenta es al aprobar.
    const available = await getLocationStockQty(db, fromLocation.id, product.id);
    if (available < qty) {
      return c.json({ ok: false, error: `Stock insuficiente de "${product.name}" en ${fromLocation.name} (disponible: ${available})` }, 409);
    }

    itemRows.push({
      id: generateUUID(),
      transferId: "", // se completa abajo tras crear el transfer
      productId: product.id,
      productCode: product.code,
      productName: product.name,
      unit: product.unit,
      qty,
    });
  }

  const transfer = await db.insert(schema.stockTransfers).values({
    id: generateUUID(),
    companyId: auth.companyId,
    fromLocationId: fromLocation.id,
    toLocationId: toLocation.id,
    requestedById: auth.userId,
    status: "pendiente",
    notes: body.notes || null,
  }).returning().get();

  for (const item of itemRows) {
    await db.insert(schema.stockTransferItems).values({ ...item, transferId: transfer.id });
  }

  await logAudit(c.env, {
    companyId: auth.companyId,
    userId: auth.userId,
    action: "transfer.create",
    entity: "stock_transfer",
    entityId: transfer.id,
    detail: { from: fromLocation.name, to: toLocation.name, items: itemRows.map(i => ({ product: i.productName, qty: i.qty })) },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: await attachItems(db, transfer) }, 201);
});

// GET /transfers — envíos donde el usuario es origen o destino (admin ve
// todos). ?status=pendiente para filtrar solo lo que falta resolver.
transfers.get("/", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { status } = c.req.query();

  let locationIds: string[] = [];
  if (auth.role !== "admin") {
    const own = await resolveOwnLocation(db, auth);
    if (!own) return c.json({ ok: true, data: [] });
    locationIds = [own.id];
  }

  const conditions: any[] = [eq(schema.stockTransfers.companyId, auth.companyId)];
  if (locationIds.length > 0) {
    conditions.push(or(
      eq(schema.stockTransfers.fromLocationId, locationIds[0]),
      eq(schema.stockTransfers.toLocationId, locationIds[0]),
    ));
  }
  if (status) conditions.push(eq(schema.stockTransfers.status, status as any));

  const rows = await db.select().from(schema.stockTransfers)
    .where(and(...conditions))
    .orderBy(desc(schema.stockTransfers.createdAt))
    .limit(100).all();

  const result = [];
  for (const t of rows) result.push(await attachItems(db, t));
  return c.json({ ok: true, data: result });
});

async function canResolveTransfer(db: ReturnType<typeof drizzle>, auth: any, transfer: typeof schema.stockTransfers.$inferSelect) {
  if (auth.role === "admin") return true;
  const toLocation = await db.select().from(schema.inventoryLocations).where(eq(schema.inventoryLocations.id, transfer.toLocationId)).get();
  if (!toLocation) return false;
  if (auth.role === "almacenista") return toLocation.type === "almacen";
  if (auth.role === "cajero") return toLocation.type === "caja" && toLocation.ownerUserId === auth.userId;
  return false;
}

// POST /transfers/:id/approve — solo el dueño del destino (o admin). Recién
// AQUÍ se descuenta del origen y se suma al destino, de forma atómica: si el
// origen ya no tiene suficiente (se vendió mientras estaba pendiente), la
// aprobación falla y el envío se queda pendiente para que el remitente
// decida (reintentar con menos cantidad, o cancelar).
transfers.post("/:id/approve", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const transfer = await db.select().from(schema.stockTransfers)
    .where(and(eq(schema.stockTransfers.id, id), eq(schema.stockTransfers.companyId, auth.companyId))).get();
  if (!transfer) return c.json({ ok: false, error: "Envío no encontrado" }, 404);
  if (transfer.status !== "pendiente") return c.json({ ok: false, error: `Este envío ya está ${transfer.status}` }, 400);
  if (!(await canResolveTransfer(db, auth, transfer))) {
    return c.json({ ok: false, error: "Solo quien recibe puede aprobar este envío" }, 403);
  }

  const items = await db.select().from(schema.stockTransferItems).where(eq(schema.stockTransferItems.transferId, id)).all();

  // Verificar TODO antes de mover nada, para no dejar un envío a medio aplicar.
  for (const item of items) {
    const available = await getLocationStockQty(db, transfer.fromLocationId, item.productId);
    if (available < item.qty) {
      return c.json({ ok: false, error: `Ya no hay suficiente "${item.productName}" en el origen (disponible: ${available}, se enviaron: ${item.qty}). Pide al remitente ajustar o cancelar el envío.` }, 409);
    }
  }

  for (const item of items) {
    await adjustLocationStock(db, transfer.fromLocationId, item.productId, -item.qty);
    await adjustLocationStock(db, transfer.toLocationId, item.productId, item.qty, { allowNegative: true });
    await db.insert(schema.stockMovements).values({
      id: generateUUID(), companyId: auth.companyId, productId: item.productId, userId: auth.userId,
      type: "salida", qty: item.qty, reason: `Envío ${id} aprobado`,
    });
  }

  const updated = await db.update(schema.stockTransfers).set({
    status: "aprobado", resolvedById: auth.userId, resolvedAt: new Date(),
  }).where(eq(schema.stockTransfers.id, id)).returning().get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "transfer.approve", entity: "stock_transfer", entityId: id,
    detail: { items: items.map(i => ({ product: i.productName, qty: i.qty })) },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: await attachItems(db, updated) });
});

// POST /transfers/:id/reject — solo el dueño del destino (o admin). No hay
// nada que revertir: el stock nunca salió del origen.
transfers.post("/:id/reject", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));

  const transfer = await db.select().from(schema.stockTransfers)
    .where(and(eq(schema.stockTransfers.id, id), eq(schema.stockTransfers.companyId, auth.companyId))).get();
  if (!transfer) return c.json({ ok: false, error: "Envío no encontrado" }, 404);
  if (transfer.status !== "pendiente") return c.json({ ok: false, error: `Este envío ya está ${transfer.status}` }, 400);
  if (!(await canResolveTransfer(db, auth, transfer))) {
    return c.json({ ok: false, error: "Solo quien recibe puede rechazar este envío" }, 403);
  }

  const updated = await db.update(schema.stockTransfers).set({
    status: "rechazado", resolvedById: auth.userId, resolvedAt: new Date(), rejectReason: body.reason || null,
  }).where(eq(schema.stockTransfers.id, id)).returning().get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "transfer.reject", entity: "stock_transfer", entityId: id,
    detail: { reason: body.reason || null },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: await attachItems(db, updated) });
});

// POST /transfers/:id/cancel — solo quien lo pidió (o admin), y solo si
// sigue pendiente. Tampoco hay nada que revertir.
transfers.post("/:id/cancel", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const transfer = await db.select().from(schema.stockTransfers)
    .where(and(eq(schema.stockTransfers.id, id), eq(schema.stockTransfers.companyId, auth.companyId))).get();
  if (!transfer) return c.json({ ok: false, error: "Envío no encontrado" }, 404);
  if (transfer.status !== "pendiente") return c.json({ ok: false, error: `Este envío ya está ${transfer.status}` }, 400);
  if (auth.role !== "admin" && transfer.requestedById !== auth.userId) {
    return c.json({ ok: false, error: "Solo quien creó el envío puede cancelarlo" }, 403);
  }

  const updated = await db.update(schema.stockTransfers).set({
    status: "cancelado", resolvedById: auth.userId, resolvedAt: new Date(),
  }).where(eq(schema.stockTransfers.id, id)).returning().get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "transfer.cancel", entity: "stock_transfer", entityId: id, detail: null,
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: await attachItems(db, updated) });
});

export default transfers;
