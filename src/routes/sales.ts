import { Hono } from "hono";
import { eq, and, gte, lte, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";
import { checkLimit } from "../middleware/plans";
import { generateUUID } from "../lib/jwt";
import { nextInvoiceNumber } from "../lib/invoiceNumber";
import { logAudit, getClientIp } from "../lib/audit";
import { resolveOwnLocation, getLocationStockQty, adjustLocationStock } from "../lib/locations";

const sales = new Hono<{ Bindings: Env }>();

sales.use("*", authMiddleware);

// FIX: permiso cambiado de "contabilidad" a "facturacion"
// para que cajeros puedan ver el historial y reimprimir facturas
sales.get("/", requireModule("facturacion"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { from, to, status } = c.req.query();

  const conditions: ReturnType<typeof eq>[] = [eq(schema.sales.companyId, auth.companyId)];
  if (status) conditions.push(eq(schema.sales.status, status as any));
  if (from) conditions.push(gte(schema.sales.date, from));
  if (to) conditions.push(lte(schema.sales.date, to));

  const rows = await db
    .select()
    .from(schema.sales)
    .where(and(...conditions))
    .orderBy(schema.sales.createdAt)
    .all();

  const result = [];
  for (const sale of rows) {
    const items = await db
      .select()
      .from(schema.saleItems)
      .where(eq(schema.saleItems.saleId, sale.id))
      .all();
    result.push({ ...sale, items });
  }
  return c.json({ ok: true, data: result });
});

sales.get("/:id", requireModule("facturacion"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const sale = await db
    .select()
    .from(schema.sales)
    .where(and(eq(schema.sales.id, id), eq(schema.sales.companyId, auth.companyId)))
    .get();
  if (!sale) return c.json({ ok: false, error: "Venta no encontrada" }, 404);

  const items = await db
    .select()
    .from(schema.saleItems)
    .where(eq(schema.saleItems.saleId, sale.id))
    .all();
  return c.json({ ok: true, data: { ...sale, items } });
});

// FIX: usa nextInvoiceNumber atómico para evitar race conditions
sales.post("/", requireModule("pos"), checkLimit("sales"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{
    clientName?: string;
    clientNit?: string;
    clientPhone?: string;
    currency?: string;
    payMethod: string;
    locationId?: string;
    items: { productId: string; qty: number }[];
    // Descuento de tipo "venta" (aplicado al total). Los de tipo "producto"
    // viajan dentro de cada item como discountId.
    discountId?: string;
  }>();

  const { clientName, clientNit, clientPhone, currency, payMethod, items } = body;

  if (!Array.isArray(items) || items.length === 0) {
    return c.json({ ok: false, error: "La venta debe tener al menos un producto" }, 400);
  }
  if (!payMethod) return c.json({ ok: false, error: "payMethod es requerido" }, 400);

  // Cada venta descuenta de la caja propia del cajero (o del almacén, si
  // vende un almacenista) — nunca de un pool global compartido. Un admin
  // sin ubicación propia debe indicar locationId explícitamente.
  let location = await resolveOwnLocation(db, auth);
  if (!location && auth.role === "admin" && body.locationId) {
    location = await db.select().from(schema.inventoryLocations)
      .where(and(eq(schema.inventoryLocations.id, body.locationId), eq(schema.inventoryLocations.companyId, auth.companyId))).get() ?? null;
  }
  if (!location) return c.json({ ok: false, error: "No tiene una ubicación de venta asignada" }, 400);

  const company = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, auth.companyId))
    .get();

  // ── Validación de moneda y método de pago contra la config de empresa ────
  const ALLOWED_PAY_METHODS = ["efectivo", "transferencia", "usd", "clasica", "zelle", "mlc", "eur", "tarjeta"];
  if (!ALLOWED_PAY_METHODS.includes(payMethod)) {
    return c.json({ ok: false, error: "Método de pago inválido" }, 400);
  }
  const settingsRow = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, auth.companyId)).get();
  const allowedCurrencies: string[] = (settingsRow?.currencies as string[]) || ["CUP"];
  const saleCurrency = (currency || company?.defaultCurrency || "CUP");
  if (!allowedCurrencies.includes(saleCurrency)) {
    return c.json({ ok: false, error: `La moneda ${saleCurrency} no está habilitada para tu negocio` }, 400);
  }

  // ── Descuentos ──────────────────────────────────────────────────────────
  const { computeDiscountAmount, isDiscountAvailable } = await import("./discounts");
  let saleDiscount: typeof schema.discounts.$inferSelect | null = null;
  if (body.discountId) {
    const d = await db.select().from(schema.discounts)
      .where(and(eq(schema.discounts.id, body.discountId), eq(schema.discounts.companyId, auth.companyId))).get();
    if (!d) return c.json({ ok: false, error: "Descuento no encontrado" }, 404);
    const check = isDiscountAvailable(d as any, location.id);
    if (!check.ok) return c.json({ ok: false, error: check.reason }, 409);
    if (d.scope !== "venta") return c.json({ ok: false, error: "Este descuento es por producto, no por venta" }, 400);
    saleDiscount = d;
  }

  let subtotal = 0;
  const lineData: { product: typeof schema.products.$inferSelect; qty: number; lineTotal: number; lineDiscount: number; discount: typeof schema.discounts.$inferSelect | null }[] = [];

  for (const it of items) {
    const product = await db
      .select()
      .from(schema.products)
      .where(
        and(
          eq(schema.products.id, it.productId),
          eq(schema.products.companyId, auth.companyId),
          eq(schema.products.active, true)
        )
      )
      .get();
    if (!product) return c.json({ ok: false, error: `Producto ${it.productId} no encontrado` }, 404);

    const qty = Number(it.qty);
    if (!qty || qty <= 0) return c.json({ ok: false, error: `Cantidad inválida para ${product.name}` }, 400);
    const available = await getLocationStockQty(db, location.id, product.id);
    if (available < qty) {
      return c.json(
        { ok: false, error: `Stock insuficiente para ${product.name} en ${location.name} (disponible: ${available})` },
        409
      );
    }

    const lineTotal = qty * Number(product.price);
    let lineDiscount = 0;
    let lineDiscountRow: typeof schema.discounts.$inferSelect | null = null;
    if ((it as any).discountId) {
      const d = await db.select().from(schema.discounts)
        .where(and(eq(schema.discounts.id, (it as any).discountId), eq(schema.discounts.companyId, auth.companyId))).get();
      if (!d) return c.json({ ok: false, error: "Descuento no encontrado" }, 404);
      const check = isDiscountAvailable(d as any, location.id);
      if (!check.ok) return c.json({ ok: false, error: `${product.name}: ${check.reason}` }, 409);
      if (d.scope !== "producto") return c.json({ ok: false, error: "Este descuento es por venta, no por producto" }, 400);
      lineDiscount = computeDiscountAmount(d as any, lineTotal, qty);
      lineDiscountRow = d;
    }
    subtotal += lineTotal;
    lineData.push({ product, qty, lineTotal, lineDiscount, discount: lineDiscountRow });
  }

  // Total de la venta = subtotal − descuentos por línea − descuento de venta
  let saleLevelDiscount = 0;
  if (saleDiscount) {
    saleLevelDiscount = computeDiscountAmount(saleDiscount as any, subtotal, undefined);
  }
  const lineDiscountsTotal = lineData.reduce((a, l) => a + l.lineDiscount, 0);
  const totalDiscount = parseFloat((saleLevelDiscount + lineDiscountsTotal).toFixed(2));

  const taxRate = Number(company?.taxRate ?? 0);
  const taxableBase = Math.max(0, subtotal - totalDiscount);
  const tax = parseFloat((taxableBase * taxRate).toFixed(2));
  const total = parseFloat((taxableBase + tax).toFixed(2));

  // Número de factura atómico — garantiza unicidad bajo concurrencia
  const invoiceNumber = await nextInvoiceNumber(c.env, auth.companyId);

  const saleId = generateUUID();
  await db.insert(schema.sales).values({
    id: saleId,
    companyId: auth.companyId,
    invoiceNumber,
    userId: auth.userId,
    locationId: location.id,
    date: new Date().toISOString().split("T")[0],
    clientName: clientName || "Consumidor Final",
    clientNit: clientNit || "00000000000",
    clientPhone: clientPhone || null,
    subtotal,
    tax,
    total,
    discountCode: saleDiscount?.code ?? null,
    discountTotal: totalDiscount,
    currency: (currency || company?.defaultCurrency || "CUP") as any,
    payMethod: payMethod as any,
    status: "emitida",
  });

  for (const { product, qty, lineTotal, lineDiscount, discount } of lineData) {
    await db.insert(schema.saleItems).values({
      id: generateUUID(),
      saleId,
      productId: product.id,
      name: product.name,
      qty,
      price: product.price,
      total: lineTotal,
      discountId: discount?.id ?? null,
      discountAmount: lineDiscount,
    });

    await adjustLocationStock(db, location.id, product.id, -qty);

    await db.insert(schema.stockMovements).values({
      id: generateUUID(),
      companyId: auth.companyId,
      productId: product.id,
      userId: auth.userId,
      type: "venta",
      qty,
      reason: `Venta ${invoiceNumber} (${location.name})`,
    });
  }

  // Incrementar contadores de uso de los descuentos aplicados
  const usedDiscountIds = new Set<string>();
  if (saleDiscount) usedDiscountIds.add(saleDiscount.id);
  for (const l of lineData) if (l.discount) usedDiscountIds.add(l.discount.id);
  for (const dId of usedDiscountIds) {
    await db.update(schema.discounts)
      .set({ usedCount: sql`${schema.discounts.usedCount} + 1` })
      .where(eq(schema.discounts.id, dId))
      .run();
  }

  const fullItems = await db
    .select()
    .from(schema.saleItems)
    .where(eq(schema.saleItems.saleId, saleId))
    .all();
  const fullSale = await db.select().from(schema.sales).where(eq(schema.sales.id, saleId)).get();
  return c.json({ ok: true, data: { ...fullSale!, items: fullItems } }, 201);
});

sales.put("/:id", requireModule("pos"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const sale = await db
    .select()
    .from(schema.sales)
    .where(and(eq(schema.sales.id, id), eq(schema.sales.companyId, auth.companyId)))
    .get();
  if (!sale) return c.json({ ok: false, error: "Venta no encontrada" }, 404);
  if (sale.status === "anulada") return c.json({ ok: false, error: "No se puede editar una venta anulada" }, 400);

  const body = await c.req.json<{
    clientName?: string;
    clientNit?: string;
    clientPhone?: string;
    payMethod?: string;
  }>();
  const updates: Partial<typeof schema.sales.$inferInsert> = {};
  if (body.clientName !== undefined) updates.clientName = body.clientName;
  if (body.clientNit !== undefined) updates.clientNit = body.clientNit;
  if (body.clientPhone !== undefined) updates.clientPhone = body.clientPhone;
  if (body.payMethod !== undefined) updates.payMethod = body.payMethod as any;

  await db.update(schema.sales).set(updates).where(eq(schema.sales.id, id));

  const updated = await db.select().from(schema.sales).where(eq(schema.sales.id, id)).get();
  const items = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, id)).all();
  return c.json({ ok: true, data: { ...updated!, items } });
});

// Anulación — restaura stock automáticamente
sales.post("/:id/void", requireModule("pos"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const sale = await db
    .select()
    .from(schema.sales)
    .where(and(eq(schema.sales.id, id), eq(schema.sales.companyId, auth.companyId)))
    .get();
  if (!sale) return c.json({ ok: false, error: "Venta no encontrada" }, 404);
  if (sale.status === "anulada") return c.json({ ok: false, error: "La venta ya está anulada" }, 400);

  const items = await db
    .select()
    .from(schema.saleItems)
    .where(eq(schema.saleItems.saleId, id))
    .all();

  for (const item of items) {
    if (!item.productId) continue;
    const product = await db
      .select()
      .from(schema.products)
      .where(and(eq(schema.products.id, item.productId), eq(schema.products.companyId, auth.companyId)))
      .get();
    if (product && sale.locationId) {
      await adjustLocationStock(db, sale.locationId, product.id, Number(item.qty), { allowNegative: true });

      await db.insert(schema.stockMovements).values({
        id: generateUUID(),
        companyId: auth.companyId,
        productId: product.id,
        userId: auth.userId,
        type: "entrada",
        qty: Number(item.qty),
        reason: `Anulación ${sale.invoiceNumber}`,
      });
    }
  }

  await db.update(schema.sales).set({ status: "anulada" }).where(eq(schema.sales.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "sale.void", entity: "sale", entityId: id,
    detail: { invoiceNumber: sale.invoiceNumber, total: sale.total },
    ip: getClientIp(c),
  });

  const updated = await db.select().from(schema.sales).where(eq(schema.sales.id, id)).get();
  return c.json({ ok: true, data: updated });
});

export default sales;
