import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireAnyModule } from "../middleware/roles";
import { logAudit, getClientIp } from "../lib/audit";
import { adjustLocationStock, StockInsufficientError, getActiveCompanyLocation } from "../lib/locations";
import { stockMovementStmt, runBatch } from "../lib/batch";

const locations = new Hono<{ Bindings: Env }>();

locations.use("*", authMiddleware);

// Devuelve true si el usuario puede ver/operar la ubicación dada:
// admin siempre (dentro de su empresa); almacenista solo el almacén; cajero
// solo su propia caja. El contador no opera inventario: no entra.
async function canAccessLocation(auth: { userId: string; role: string }, location: typeof schema.inventoryLocations.$inferSelect) {
  if (auth.role === "admin") return true;
  if (auth.role === "almacenista") return location.type === "almacen";
  if (auth.role === "cajero") return location.type === "caja" && location.ownerUserId === auth.userId;
  return false;
}

// GET /locations — metadata básica (id, nombre, tipo) de TODAS las
// ubicaciones de la empresa, visible para cualquier usuario autenticado —
// es lo que se necesita para elegir un destino al crear un envío. El STOCK
// de cada ubicación es lo que de verdad está restringido (ver /:id/stock).
locations.get("/", requireAnyModule("inventario", "pos", "facturacion", "cierre", "transferencias"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const rows = await db.select().from(schema.inventoryLocations)
    .where(eq(schema.inventoryLocations.companyId, auth.companyId)).all();
  return c.json({ ok: true, data: rows });
});

// GET /locations/:id/stock — catálogo + cantidad disponible en ESA ubicación.
// Esto es lo que usan Inventario (almacén/caja) y el POS para saber qué hay
// realmente disponible para vender/gestionar ahí — nunca el total de la
// empresa.
locations.get("/:id/stock", requireAnyModule("inventario", "pos", "facturacion"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const location = await getActiveCompanyLocation(db, auth.companyId, id);
  if (!location) return c.json({ ok: false, error: "Ubicación no encontrada" }, 404);
  if (!(await canAccessLocation(auth, location))) {
    return c.json({ ok: false, error: "No tiene permisos para ver esta ubicación" }, 403);
  }

  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).all();
  const stockRows = await db.select().from(schema.locationStock)
    .where(eq(schema.locationStock.locationId, id)).all();
  const stockMap: Record<string, number> = {};
  for (const r of stockRows) stockMap[r.productId] = Number(r.qty);

  const items = products.map(p => ({
    id: p.id,
    code: p.code,
    barcode: p.barcode,
    currency: p.currency,
    name: p.name,
    category: p.category,
    unit: p.unit,
    price: p.price,
    cost: p.cost,
    minStock: p.minStock,
    active: p.active,
    stock: stockMap[p.id] ?? 0, // stock EN ESTA ubicación, no el total de empresa
  }));

  return c.json({ ok: true, data: { location, items } });
});

// POST /locations/:id/adjust — ajuste manual de stock (entrada/salida) en
// una ubicación puntual. El ajuste y su movimiento se escriben juntos: o queda
// el stock y el movimiento, o no queda ninguno.
locations.post("/:id/adjust", requireAnyModule("inventario", "pos"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const location = await getActiveCompanyLocation(db, auth.companyId, id);
  if (!location) return c.json({ ok: false, error: "Ubicación no encontrada" }, 404);
  if (!(await canAccessLocation(auth, location))) {
    return c.json({ ok: false, error: "No tiene permisos para ajustar esta ubicación" }, 403);
  }

  const body = await c.req.json<{ productId: string; type: "entrada" | "salida"; qty: number; reason?: string }>();
  const { productId, type, qty, reason } = body;
  const qtyNum = Number(qty);
  if (!productId || !["entrada", "salida"].includes(type) || !Number.isFinite(qtyNum) || qtyNum <= 0) {
    return c.json({ ok: false, error: "productId, type (entrada|salida) y qty > 0 son requeridos" }, 400);
  }

  const product = await db.select().from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.companyId, auth.companyId))).get();
  if (!product) return c.json({ ok: false, error: "Producto no encontrado" }, 404);

  let newQty: number;
  try {
    newQty = await adjustLocationStock(c.env, id, productId, type === "entrada" ? qtyNum : -qtyNum);
  } catch (err) {
    if (err instanceof StockInsufficientError) {
      return c.json({ ok: false, error: `Stock insuficiente en ${location.name}` }, 409);
    }
    throw err;
  }

  await runBatch(c.env.DB, [
    stockMovementStmt(c.env.DB, {
      companyId: auth.companyId,
      productId,
      userId: auth.userId,
      locationId: id,
      type,
      qty: qtyNum,
      reason: reason ? `[${location.name}] ${reason}` : `Ajuste manual en ${location.name}`,
    }),
  ]);

  await logAudit(c.env, {
    companyId: auth.companyId,
    userId: auth.userId,
    action: "location.adjust_stock",
    entity: "location_stock",
    entityId: id,
    detail: { locationName: location.name, productId, productName: product.name, type, qty: qtyNum, reason: reason || null, newQty },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: { locationId: id, productId, qty: newQty } });
});

export default locations;
