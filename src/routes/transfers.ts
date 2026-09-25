import { Hono } from "hono";
import { eq, and, or, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { resolveOwnLocation, getLocationStockQty, getActiveCompanyLocation } from "../lib/locations";
import {
  ensureLocationStockStmt,
  decrementStockStmt,
  incrementStockStmt,
  recomputeProductStockStmt,
  stockMovementStmt,
  auditStmt,
  runBatch,
  errorMessage,
} from "../lib/batch";

const transfers = new Hono<{ Bindings: Env }>();

// Los envíos son de almacenista, cajero y admin (ver matriz en middleware/roles).
transfers.use("*", authMiddleware, requireModule("transferencias"));

async function attachItems(db: ReturnType<typeof drizzle>, transfer: typeof schema.stockTransfers.$inferSelect) {
  const items = await db.select().from(schema.stockTransferItems)
    .where(eq(schema.stockTransferItems.transferId, transfer.id)).all();
  return { ...transfer, items };
}

/**
 * ¿Quién puede resolver (aprobar/rechazar) este envío?
 * SOLO el dueño de la ubicación de DESTINO, y la ubicación debe ser de su
 * empresa. Admin NO puede: hasta ahora el comentario del código decía "(o
 * admin)" pero la función no lo permitía, así que el admin veía botones que
 * terminaban en 403. Ahora la respuesta 403 lo dice claro y, además, cada envío
 * trae `canResolve` para que el cliente no muestre una acción que va a fallar.
 */
async function canResolveTransfer(
  db: ReturnType<typeof drizzle>,
  auth: { userId: string; role: string; companyId: string },
  transfer: typeof schema.stockTransfers.$inferSelect
): Promise<boolean> {
  const toLocation = await getActiveCompanyLocation(db, auth.companyId, transfer.toLocationId);
  if (!toLocation) return false;
  if (auth.role === "almacenista") return toLocation.type === "almacen";
  if (auth.role === "cajero") return toLocation.type === "caja" && toLocation.ownerUserId === auth.userId;
  return false;
}

const RESOLVE_403 = {
  ok: false,
  error: "Solo quien recibe el envío (el dueño de la ubicación de destino) puede aprobarlo o rechazarlo",
  code: "TRANSFER_NOT_RECIPIENT",
};

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

  // El admin debe decir de dónde sale; el resto usa su ubicación y no puede
  // enviar desde la de otro.
  const fromLocation = auth.role === "admin"
    ? (body.fromLocationId
        ? await getActiveCompanyLocation(db, auth.companyId, body.fromLocationId)
        : null)
    : await resolveOwnLocation(db, auth);

  if (auth.role === "admin" && !body.fromLocationId) {
    return c.json({ ok: false, error: "Indique la ubicación de origen (fromLocationId)" }, 400);
  }
  if (!fromLocation) return c.json({ ok: false, error: "No se pudo determinar la ubicación de origen" }, 400);

  if (!body.toLocationId) return c.json({ ok: false, error: "toLocationId es requerido" }, 400);
  if (body.toLocationId === fromLocation.id) {
    return c.json({ ok: false, error: "El origen y destino no pueden ser la misma ubicación" }, 400);
  }

  const toLocation = await getActiveCompanyLocation(db, auth.companyId, body.toLocationId);
  if (!toLocation) return c.json({ ok: false, error: "Ubicación de destino no encontrada o inactiva" }, 404);

  if (!Array.isArray(body.items) || body.items.length === 0) {
    return c.json({ ok: false, error: "El envío debe tener al menos un producto" }, 400);
  }

  const seen = new Set<string>();
  const itemRows: (typeof schema.stockTransferItems.$inferInsert)[] = [];
  for (const it of body.items) {
    const qty = Number(it?.qty);
    if (!Number.isFinite(qty) || qty <= 0) {
      return c.json({ ok: false, error: "Cantidad inválida en uno de los productos" }, 400);
    }
    if (seen.has(it.productId)) {
      return c.json({ ok: false, error: "El mismo producto aparece dos veces en el envío" }, 400);
    }
    seen.add(it.productId);

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

  const transferId = generateUUID();
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO stock_transfers (id, company_id, from_location_id, to_location_id, requested_by_id, status, notes, created_at)
       VALUES (?, ?, ?, ?, ?, 'pendiente', ?, unixepoch())`
    ).bind(transferId, auth.companyId, fromLocation.id, toLocation.id, auth.userId, (body.notes || "").trim() || null),
  ];
  for (const item of itemRows) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO stock_transfer_items (id, transfer_id, product_id, product_code, product_name, unit, qty)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(item.id, transferId, item.productId, item.productCode, item.productName, item.unit, item.qty)
    );
  }
  stmts.push(
    auditStmt(c.env.DB, {
      companyId: auth.companyId, userId: auth.userId,
      action: "transfer.create", entity: "stock_transfer", entityId: transferId,
      detail: { from: fromLocation.name, to: toLocation.name, items: itemRows.map((i) => ({ product: i.productName, qty: i.qty })) },
      ip: getClientIp(c),
    })
  );

  try {
    await runBatch(c.env.DB, stmts);
  } catch (err) {
    console.error("transfers/create: batch falló:", errorMessage(err));
    return c.json({ ok: false, error: "No se pudo crear el envío. Inténtalo de nuevo." }, 503);
  }

  const transfer = await db.select().from(schema.stockTransfers)
    .where(and(eq(schema.stockTransfers.id, transferId), eq(schema.stockTransfers.companyId, auth.companyId))).get();
  return c.json({ ok: true, data: await attachItems(db, transfer!) }, 201);
});

// GET /transfers — envíos donde el usuario es origen o destino (admin ve
// todos). ?status=pendiente para filtrar solo lo que falta resolver.
transfers.get("/", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { status } = c.req.query();

  const conditions: ReturnType<typeof eq>[] = [eq(schema.stockTransfers.companyId, auth.companyId)];
  if (auth.role !== "admin") {
    const own = await resolveOwnLocation(db, auth);
    if (!own) return c.json({ ok: true, data: [] });
    conditions.push(
      or(
        eq(schema.stockTransfers.fromLocationId, own.id),
        eq(schema.stockTransfers.toLocationId, own.id)
      )!
    );
  }
  if (status) conditions.push(eq(schema.stockTransfers.status, status as any));

  const rows = await db.select().from(schema.stockTransfers)
    .where(and(...conditions))
    .orderBy(desc(schema.stockTransfers.createdAt))
    .limit(100).all();

  const result = [];
  for (const t of rows) {
    const withItems = await attachItems(db, t);
    result.push({
      ...withItems,
      // El cliente usa estas banderas en vez de adivinar por rol: así nunca
      // muestra "Aprobar" a quien va a recibir un 403.
      canResolve: t.status === "pendiente" && (await canResolveTransfer(db, auth, t)),
      canCancel: t.status === "pendiente" && (auth.role === "admin" || t.requestedById === auth.userId),
    });
  }
  return c.json({ ok: true, data: result });
});

// POST /transfers/:id/approve — solo el dueño del destino. Recién AQUÍ se
// descuenta del origen y se suma al destino, de forma atómica: si el origen ya
// no tiene suficiente (se vendió mientras estaba pendiente), la aprobación falla
// y el envío se queda pendiente para que el remitente decida.
transfers.post("/:id/approve", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const transfer = await db.select().from(schema.stockTransfers)
    .where(and(eq(schema.stockTransfers.id, id), eq(schema.stockTransfers.companyId, auth.companyId))).get();
  if (!transfer) return c.json({ ok: false, error: "Envío no encontrado" }, 404);
  if (transfer.status !== "pendiente") return c.json({ ok: false, error: `Este envío ya está ${transfer.status}` }, 400);
  if (!(await canResolveTransfer(db, auth, transfer))) return c.json(RESOLVE_403, 403);

  const items = await db.select().from(schema.stockTransferItems)
    .where(eq(schema.stockTransferItems.transferId, id)).all();

  // Verificar TODO antes de mover nada, para no dejar un envío a medio aplicar.
  for (const item of items) {
    const available = await getLocationStockQty(db, transfer.fromLocationId, item.productId);
    if (available < item.qty) {
      return c.json({ ok: false, error: `Ya no hay suficiente "${item.productName}" en el origen (disponible: ${available}, se enviaron: ${item.qty}). Pide al remitente ajustar o cancelar el envío.` }, 409);
    }
  }

  const stmts: D1PreparedStatement[] = [
    // Reclamo del envío.
    // SIN `AND status = 'pendiente'` a propósito: con ese filtro, una segunda
    // aprobación cambiaría 0 filas, el trigger no se dispararía y el stock se
    // movería igual dos veces. Sin el filtro, trg_transfers_resolve_once (0007)
    // aborta el batch completo y el catch devuelve 409.
    c.env.DB.prepare(
      `UPDATE stock_transfers SET status = 'aprobado', resolved_by_id = ?, resolved_at = unixepoch()
        WHERE id = ?`
    ).bind(auth.userId, id),
  ];
  for (const item of items) {
    stmts.push(ensureLocationStockStmt(c.env.DB, transfer.toLocationId, item.productId));
    stmts.push(decrementStockStmt(c.env.DB, transfer.fromLocationId, item.productId, item.qty));
    stmts.push(incrementStockStmt(c.env.DB, transfer.toLocationId, item.productId, item.qty));
    stmts.push(stockMovementStmt(c.env.DB, {
      companyId: auth.companyId, productId: item.productId, userId: auth.userId,
      locationId: transfer.fromLocationId, type: "salida", qty: item.qty,
      reason: `Envío ${id} aprobado`,
    }));
    stmts.push(recomputeProductStockStmt(c.env.DB, item.productId));
  }
  stmts.push(auditStmt(c.env.DB, {
    companyId: auth.companyId, userId: auth.userId,
    action: "transfer.approve", entity: "stock_transfer", entityId: id,
    detail: { items: items.map((i) => ({ product: i.productName, qty: i.qty })) },
    ip: getClientIp(c),
  }));

  try {
    await runBatch(c.env.DB, stmts);
  } catch (err) {
    const msg = errorMessage(err);
    if (/ya fue resuelto/i.test(msg) || /stock insuficiente/i.test(msg)) {
      return c.json({ ok: false, error: "Este envío ya no está pendiente o el origen ya no tiene stock." }, 409);
    }
    console.error("transfers/approve: batch falló y se revirtió:", msg);
    return c.json({ ok: false, error: "No se pudo aprobar el envío. Inténtalo de nuevo." }, 503);
  }

  const updated = await db.select().from(schema.stockTransfers)
    .where(eq(schema.stockTransfers.id, id)).get();
  return c.json({ ok: true, data: await attachItems(db, updated!) });
});

// POST /transfers/:id/reject — solo el dueño del destino. No hay nada que
// revertir: el stock nunca salió del origen.
transfers.post("/:id/reject", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = await c.req.json<{ reason?: string }>().catch(() => ({} as { reason?: string }));

  const transfer = await db.select().from(schema.stockTransfers)
    .where(and(eq(schema.stockTransfers.id, id), eq(schema.stockTransfers.companyId, auth.companyId))).get();
  if (!transfer) return c.json({ ok: false, error: "Envío no encontrado" }, 404);
  if (transfer.status !== "pendiente") return c.json({ ok: false, error: `Este envío ya está ${transfer.status}` }, 400);
  if (!(await canResolveTransfer(db, auth, transfer))) return c.json(RESOLVE_403, 403);

  let updated;
  try {
    const changes = await runBatch(c.env.DB, [
      c.env.DB.prepare(
        `UPDATE stock_transfers SET status = 'rechazado', resolved_by_id = ?, resolved_at = unixepoch(), reject_reason = ?
          WHERE id = ?`
      ).bind(auth.userId, (body.reason || "").trim() || null, id),
    ]);
    if ((changes[0] ?? 0) === 0) return c.json({ ok: false, error: "Este envío ya no está pendiente" }, 409);
    updated = await db.select().from(schema.stockTransfers).where(eq(schema.stockTransfers.id, id)).get();
  } catch (err) {
    if (/ya fue resuelto/i.test(errorMessage(err))) {
      return c.json({ ok: false, error: "Este envío ya fue resuelto" }, 409);
    }
    return c.json({ ok: false, error: "No se pudo rechazar el envío." }, 503);
  }

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "transfer.reject", entity: "stock_transfer", entityId: id,
    detail: { reason: (body.reason || "").trim() || null },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: await attachItems(db, updated!) });
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
    return c.json({ ok: false, error: "Solo quien creó el envío puede cancelarlo", code: "TRANSFER_NOT_OWNER" }, 403);
  }

  let updated;
  try {
    const changes = await runBatch(c.env.DB, [
      c.env.DB.prepare(
        `UPDATE stock_transfers SET status = 'cancelado', resolved_by_id = ?, resolved_at = unixepoch()
          WHERE id = ?`
      ).bind(auth.userId, id),
    ]);
    if ((changes[0] ?? 0) === 0) return c.json({ ok: false, error: "Este envío ya no está pendiente" }, 409);
    updated = await db.select().from(schema.stockTransfers).where(eq(schema.stockTransfers.id, id)).get();
  } catch (err) {
    if (/ya fue resuelto/i.test(errorMessage(err))) {
      return c.json({ ok: false, error: "Este envío ya fue resuelto" }, 409);
    }
    return c.json({ ok: false, error: "No se pudo cancelar el envío." }, 503);
  }

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "transfer.cancel", entity: "stock_transfer", entityId: id, detail: null,
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: await attachItems(db, updated!) });
});

export default transfers;
