import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { adjustLocationStock, getLocationStockQty } from "../lib/locations";

const locations = new Hono<{ Bindings: Env }>();

locations.use("*", authMiddleware);

// Devuelve true si el usuario puede ver/operar la ubicación dada:
// admin siempre; almacenista solo el almacén; cajero solo su propia caja.
async function canAccessLocation(db: ReturnType<typeof drizzle>, auth: any, location: typeof schema.inventoryLocations.$inferSelect) {
  if (auth.role === "admin") return true;
  if (auth.role === "almacenista") return location.type === "almacen";
  if (auth.role === "cajero") return location.type === "caja" && location.ownerUserId === auth.userId;
  return false;
}

// GET /locations — metadata básica (id, nombre, tipo) de TODAS las
// ubicaciones de la empresa, visible para cualquier usuario autenticado —
// es lo que se necesita para elegir un destino al crear un envío. El STOCK
// de cada ubicación es lo que de verdad está restringido (ver /:id/stock).
locations.get("/", async (c) => {
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
locations.get("/:id/stock", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const location = await db.select().from(schema.inventoryLocations)
    .where(and(eq(schema.inventoryLocations.id, id), eq(schema.inventoryLocations.companyId, auth.companyId))).get();
  if (!location) return c.json({ ok: false, error: "Ubicación no encontrada" }, 404);
  if (!(await canAccessLocation(db, auth, location))) {
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
// una ubicación puntual. Reemplaza al viejo /products/:id/adjust-stock, que
// operaba sobre un único stock global sin sentido ahora que hay varias
// ubicaciones.
locations.post("/:id/adjust", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const location = await db.select().from(schema.inventoryLocations)
    .where(and(eq(schema.inventoryLocations.id, id), eq(schema.inventoryLocations.companyId, auth.companyId))).get();
  if (!location) return c.json({ ok: false, error: "Ubicación no encontrada" }, 404);
  if (!(await canAccessLocation(db, auth, location))) {
    return c.json({ ok: false, error: "No tiene permisos para ajustar esta ubicación" }, 403);
  }

  const body = await c.req.json<{ productId: string; type: "entrada" | "salida"; qty: number; reason?: string }>();
  const { productId, type, qty, reason } = body;
  if (!productId || !["entrada", "salida"].includes(type) || !qty || qty <= 0) {
    return c.json({ ok: false, error: "productId, type (entrada|salida) y qty > 0 son requeridos" }, 400);
  }

  const product = await db.select().from(schema.products)
    .where(and(eq(schema.products.id, productId), eq(schema.products.companyId, auth.companyId))).get();
  if (!product) return c.json({ ok: false, error: "Producto no encontrado" }, 404);

  const delta = type === "entrada" ? qty : -qty;
  let newQty: number;
  try {
    newQty = await adjustLocationStock(db, id, productId, delta);
  } catch (err: any) {
    return c.json({ ok: false, error: err.message }, 409);
  }

  await db.insert(schema.stockMovements).values({
    id: generateUUID(),
    companyId: auth.companyId,
    productId,
    userId: auth.userId,
    type,
    qty,
    reason: reason ? `[${location.name}] ${reason}` : `Ajuste manual en ${location.name}`,
  });

  await logAudit(c.env, {
    companyId: auth.companyId,
    userId: auth.userId,
    action: "location.adjust_stock",
    entity: "location_stock",
    entityId: id,
    detail: { locationName: location.name, productId, productName: product.name, type, qty, reason: reason || null, newQty },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: { locationId: id, productId, qty: newQty } });
});

export default locations;
