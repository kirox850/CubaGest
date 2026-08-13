import { Hono } from "hono";
import { eq, and, like, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireAnyModule } from "../middleware/roles";
import { checkLimit } from "../middleware/plans";
import { generateUUID } from "../lib/jwt";

const products = new Hono<{ Bindings: Env }>();

products.use("*", authMiddleware);

// Leer el catálogo lo necesita cualquier módulo que venda o facture
// productos, no solo quien administra el inventario.
products.get("/", requireAnyModule("inventario", "pos", "facturacion"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { search, category } = c.req.query();

  let conditions: any[] = [eq(schema.products.companyId, auth.companyId)];
  if (category && category !== "Todas") conditions.push(eq(schema.products.category, category));
  if (search) {
    conditions.push(or(
      like(schema.products.name, `%${search}%`),
      like(schema.products.code, `%${search}%`)
    ));
  }

  const rows = await db.select().from(schema.products)
    .where(and(...conditions))
    .orderBy(schema.products.code)
    .all();
  return c.json({ ok: true, data: rows });
});

products.post("/", requireModule("inventario"), checkLimit("products"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ code: string; name: string; category?: string; unit?: string; price: number; cost?: number; stock?: number; minStock?: number }>();
  const { code, name, category, unit, price, cost, stock, minStock } = body;

  if (!code || !name || price === undefined) {
    return c.json({ ok: false, error: "code, name y price son requeridos" }, 400);
  }

  const product = await db.insert(schema.products).values({
    id: generateUUID(),
    companyId: auth.companyId,
    code, name,
    category: category || "Otros",
    unit: unit || "ud",
    price, cost: cost || 0, stock: stock || 0, minStock: minStock || 0,
  }).returning().get();

  return c.json({ ok: true, data: product }, 201);
});

products.put("/:id", requireModule("inventario"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const existing = await db.select().from(schema.products)
    .where(and(eq(schema.products.id, id), eq(schema.products.companyId, auth.companyId))).get();
  if (!existing) return c.json({ ok: false, error: "Producto no encontrado" }, 404);

  const body = await c.req.json<Partial<typeof schema.products.$inferInsert>>();
  const updates: Partial<typeof schema.products.$inferInsert> = {};
  const fields = ["code", "name", "category", "unit", "price", "cost", "minStock", "active"] as const;
  for (const f of fields) {
    if (body[f] !== undefined) (updates as any)[f] = body[f];
  }
  updates.updatedAt = new Date();

  await db.update(schema.products).set(updates).where(eq(schema.products.id, id));
  const updated = await db.select().from(schema.products).where(eq(schema.products.id, id)).get();
  return c.json({ ok: true, data: updated });
});

products.delete("/:id", requireModule("inventario"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const existing = await db.select().from(schema.products)
    .where(and(eq(schema.products.id, id), eq(schema.products.companyId, auth.companyId))).get();
  if (!existing) return c.json({ ok: false, error: "Producto no encontrado" }, 404);

  await db.update(schema.products).set({ active: false, updatedAt: new Date() }).where(eq(schema.products.id, id));
  return c.json({ ok: true });
});

products.post("/:id/reactivate", requireModule("inventario"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const existing = await db.select().from(schema.products)
    .where(and(eq(schema.products.id, id), eq(schema.products.companyId, auth.companyId))).get();
  if (!existing) return c.json({ ok: false, error: "Producto no encontrado" }, 404);

  await db.update(schema.products).set({ active: true, updatedAt: new Date() }).where(eq(schema.products.id, id));
  const updated = await db.select().from(schema.products).where(eq(schema.products.id, id)).get();
  return c.json({ ok: true, data: updated });
});

products.post("/:id/adjust-stock", requireModule("inventario"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = await c.req.json<{ type: "entrada" | "salida"; qty: number; reason?: string }>();
  const { type, qty, reason } = body;

  if (!["entrada", "salida"].includes(type) || !qty || qty <= 0) {
    return c.json({ ok: false, error: "type debe ser entrada|salida y qty > 0" }, 400);
  }

  const product = await db.select().from(schema.products)
    .where(and(eq(schema.products.id, id), eq(schema.products.companyId, auth.companyId))).get();
  if (!product) return c.json({ ok: false, error: "Producto no encontrado" }, 404);

  const newStock = type === "entrada"
    ? Number(product.stock) + qty
    : Math.max(0, Number(product.stock) - qty);

  await db.update(schema.products).set({ stock: newStock, updatedAt: new Date() }).where(eq(schema.products.id, id));

  await db.insert(schema.stockMovements).values({
    id: generateUUID(),
    companyId: auth.companyId,
    productId: product.id,
    userId: auth.userId,
    type, qty, reason: reason || null,
  });

  const updated = await db.select().from(schema.products).where(eq(schema.products.id, id)).get();
  return c.json({ ok: true, data: updated });
});

products.get("/low-stock", requireModule("inventario"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const rows = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true)))
    .all();
  const low = rows.filter(p => Number(p.stock) <= Number(p.minStock));
  return c.json({ ok: true, data: low });
});

export default products;
