import { Hono } from "hono";
import { eq, and, like, or } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireAnyModule } from "../middleware/roles";
import { checkLimit } from "../middleware/plans";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { ensureAlmacenLocation, adjustLocationStock } from "../lib/locations";
import { stockMovementStmt, runBatch } from "../lib/batch";

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
      like(schema.products.code, `%${search}%`),
      // Código de barras: el buscador del POS y del inventario también
      // matchea por aquí (los lectores USB/Bluetooth "escriben" el código
      // en el buscador, y la cámara web escanea al mismo campo).
      like(schema.products.barcode, `%${search}%`)
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
  const body = await c.req.json<{ code: string; barcode?: string; currency?: string; name: string; category?: string; unit?: string; price: number; cost?: number; stock?: number; minStock?: number }>();
  const { code, name, category, unit, price, cost, stock, minStock } = body;

  if (!code || !name || price === undefined) {
    return c.json({ ok: false, error: "code, name y price son requeridos" }, 400);
  }
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum) || priceNum < 0) {
    return c.json({ ok: false, error: "price debe ser un número >= 0" }, 400);
  }
  const initialStock = Number(stock ?? 0);
  if (!Number.isFinite(initialStock) || initialStock < 0) {
    return c.json({ ok: false, error: "stock debe ser un número >= 0" }, 400);
  }

  // Todo producto nuevo nace en el Almacén Central — de ahí se reparte a las
  // cajas mediante envíos. `ensureAlmacenLocation` crea el almacén si la
  // empresa no lo tuviera (empresas viejas o registros a medias): antes, sin
  // almacén, el stock inicial se guardaba en products.stock y NO existía en
  // ninguna caja, y la venta la rechazaba por falta de existencias.
  const almacen = await ensureAlmacenLocation(db, auth.companyId);
  if (!almacen) {
    return c.json(
      { ok: false, error: "No se pudo obtener el Almacén Central de la empresa. Contacte a soporte." },
      500
    );
  }

  const product = await db.insert(schema.products).values({
    id: generateUUID(),
    companyId: auth.companyId,
    code, name,
    barcode: body.barcode?.trim() || null,
    currency: (body.currency || "CUP").toUpperCase(),
    category: category || "Otros",
    unit: unit || "ud",
    price: priceNum, cost: Number(cost) || 0, stock: 0, minStock: Number(minStock) || 0,
  }).returning().get();

  // El stock inicial se siembra en el almacén y deja movimiento de inventario:
  // si no se puede sembrar, se falla claramente en vez de crear un producto
  // que no se puede vender.
  if (initialStock > 0) {
    try {
      await adjustLocationStock(c.env, almacen.id, product.id, initialStock, { allowNegative: true });
      await runBatch(c.env.DB, [
        stockMovementStmt(c.env.DB, {
          companyId: auth.companyId,
          productId: product.id,
          userId: auth.userId,
          locationId: almacen.id,
          type: "entrada",
          qty: initialStock,
          reason: `Stock inicial en ${almacen.name}`,
        }),
      ]);
    } catch (err) {
      console.error("products: no se pudo sembrar el stock inicial:", err);
      return c.json(
        { ok: false, error: "El producto se creó pero no se pudo registrar el stock inicial. Revise el Almacén Central.", code: "INITIAL_STOCK_FAILED" },
        500
      );
    }
  }
  const finalProduct = await db.select().from(schema.products).where(eq(schema.products.id, product.id)).get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "product.create", entity: "product", entityId: product.id,
    detail: { code, name, price: priceNum, initialStock, location: almacen.name },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: finalProduct }, 201);
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
  const fields = ["code", "barcode", "currency", "name", "category", "unit", "price", "cost", "minStock", "active"] as const;
  for (const f of fields) {
    if (body[f] !== undefined) (updates as any)[f] = body[f];
  }
  updates.updatedAt = new Date();

  await db.update(schema.products).set(updates).where(eq(schema.products.id, id));
  const updated = await db.select().from(schema.products).where(eq(schema.products.id, id)).get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "product.update", entity: "product", entityId: id,
    detail: { before: { name: existing.name, price: existing.price, cost: existing.cost, active: existing.active }, changes: updates },
    ip: getClientIp(c),
  });

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

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "product.deactivate", entity: "product", entityId: id,
    detail: { name: existing.name, code: existing.code },
    ip: getClientIp(c),
  });

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

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "product.reactivate", entity: "product", entityId: id,
    detail: { name: existing.name, code: existing.code },
    ip: getClientIp(c),
  });

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
