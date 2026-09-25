import { Hono } from "hono";
import { eq, and, gte, lte, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, canMutateSale } from "../middleware/roles";
import { getClientIp } from "../lib/audit";
import {
  createSale,
  voidSale,
  validateClientSaleId,
  ALLOWED_PAY_METHODS,
  type SaleLineInput,
} from "../lib/sales";

const sales = new Hono<{ Bindings: Env }>();

sales.use("*", authMiddleware);

interface SaleBody {
  clientSaleId?: string;
  clientName?: string;
  clientNit?: string;
  clientPhone?: string;
  currency?: string;
  payMethod?: string;
  locationId?: string;
  items?: SaleLineInput[];
  // Descuento de tipo "venta" (aplicado al total). Los de tipo "producto"
  // viajan dentro de cada item como discountId.
  discountId?: string;
}

function validateBody(body: SaleBody) {
  if (body.payMethod !== undefined && typeof body.payMethod !== "string") {
    return "payMethod debe ser texto";
  }
  if (body.payMethod && !(ALLOWED_PAY_METHODS as readonly string[]).includes(body.payMethod)) {
    return "Método de pago inválido";
  }
  if (body.items !== undefined && !Array.isArray(body.items)) {
    return "items debe ser una lista";
  }
  if (body.clientName !== undefined && typeof body.clientName !== "string") {
    return "clientName debe ser texto";
  }
  if (body.currency !== undefined && typeof body.currency !== "string") {
    return "currency debe ser texto";
  }
  if (body.discountId !== undefined && body.discountId !== null && typeof body.discountId !== "string") {
    return "discountId debe ser texto";
  }
  if (body.locationId !== undefined && body.locationId !== null && typeof body.locationId !== "string") {
    return "locationId debe ser texto";
  }
  return null;
}

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

  // Una sola consulta para las líneas de todas las ventas de la página, en
  // vez de una por venta.
  const saleIds = rows.map((r) => r.id);
  const itemsBySale = new Map<string, typeof schema.saleItems.$inferSelect[]>();
  if (saleIds.length > 0) {
    const allItems = await db
      .select()
      .from(schema.saleItems)
      .where(inArray(schema.saleItems.saleId, saleIds))
      .all();
    for (const item of allItems) {
      const list = itemsBySale.get(item.saleId) ?? [];
      list.push(item);
      itemsBySale.set(item.saleId, list);
    }
  }

  const result = rows.map((sale) => ({ ...sale, items: itemsBySale.get(sale.id) ?? [] }));
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

// POST /sales
// Todo el cálculo (precio, descuentos, impuesto, total) y toda la escritura
// (venta, líneas, stock, movimientos, contadores, auditoría) ocurren en el
// núcleo compartido src/lib/sales.ts, en un único batch atómico de D1.
//
// El límite de ventas del plan NO se comprueba aquí con checkLimit("sales"):
// createSale ya lo evalúa (misma regla, fecha del servidor) DESPUÉS de
// comprobar la idempotencia, de modo que reenviar una venta ya sincronizada
// devuelve su factura original en vez de un 403 por límite alcanzado — que es
// justo lo que pasa cuando el cliente recupera internet con cola offline.
sales.post("/", requireModule("pos"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<SaleBody>().catch(() => null);
  if (!body) return c.json({ ok: false, error: "Cuerpo de la petición inválido" }, 400);

  const shapeError = validateBody(body);
  if (shapeError) return c.json({ ok: false, error: shapeError }, 400);

  // clientSaleId es OPCIONAL aquí (el cliente viejo no lo manda) pero si llega
  // se valida y activa la idempotencia: reenviar la misma venta devuelve la
  // factura original en vez de duplicarla.
  const clientId = validateClientSaleId(body.clientSaleId);
  if (!clientId.ok) return c.json({ ok: false, error: clientId.error, code: "CLIENT_SALE_ID_INVALID" }, 400);

  if (!body.payMethod) return c.json({ ok: false, error: "payMethod es requerido" }, 400);

  const result = await createSale(c.env, db, auth, {
    clientSaleId: clientId.value,
    clientName: body.clientName,
    clientNit: body.clientNit,
    clientPhone: body.clientPhone,
    currency: body.currency,
    payMethod: body.payMethod,
    locationId: body.locationId ?? null,
    items: (body.items ?? []) as SaleLineInput[],
    discountId: body.discountId ?? null,
    ip: getClientIp(c),
  });

  if (!result.ok) {
    return c.json({ ok: false, error: result.error, code: result.code }, result.status as any);
  }
  return c.json(
    {
      ok: true,
      data: { ...result.sale, items: result.items },
      duplicate: result.duplicate,
    },
    result.duplicate ? 200 : 201
  );
});

// PUT /sales/:id — solo datos del cliente y método de pago. Los importes, las
// líneas y el stock NO se tocan: para eso se anula y se vuelve a vender.
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

  const perm = canMutateSale(auth, { userId: sale.userId, locationId: sale.locationId });
  if (!perm.allowed) return c.json({ ok: false, error: perm.reason, code: "SALE_FORBIDDEN" }, 403);

  const body = await c.req.json<{
    clientName?: string;
    clientNit?: string;
    clientPhone?: string;
    payMethod?: string;
  }>();

  if (body.payMethod !== undefined && !(ALLOWED_PAY_METHODS as readonly string[]).includes(body.payMethod)) {
    return c.json({ ok: false, error: "Método de pago inválido" }, 400);
  }

  const updates: Partial<typeof schema.sales.$inferInsert> = {};
  if (body.clientName !== undefined) updates.clientName = body.clientName;
  if (body.clientNit !== undefined) updates.clientNit = body.clientNit;
  if (body.clientPhone !== undefined) updates.clientPhone = body.clientPhone;
  if (body.payMethod !== undefined) updates.payMethod = body.payMethod as any;

  if (Object.keys(updates).length === 0) {
    return c.json({ ok: false, error: "No hay cambios para guardar" }, 400);
  }

  await db.update(schema.sales).set(updates).where(eq(schema.sales.id, id));
  await logSaleEdit(c.env, {
    companyId: auth.companyId,
    userId: auth.userId,
    saleId: id,
    invoiceNumber: sale.invoiceNumber,
    changes: updates,
    ip: getClientIp(c),
  });

  const updated = await db.select().from(schema.sales).where(eq(schema.sales.id, id)).get();
  const items = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, id)).all();
  return c.json({ ok: true, data: { ...updated!, items } });
});

async function logSaleEdit(
  env: Env,
  row: {
    companyId: string;
    userId: string;
    saleId: string;
    invoiceNumber: string;
    changes: Record<string, unknown>;
    ip: string | null;
  }
) {
  await env.DB.prepare(
    `INSERT INTO audit_logs (id, company_id, user_id, action, entity, entity_id, detail, ip, created_at)
     VALUES (?, ?, ?, 'sale.update', 'sale', ?, ?, ?, unixepoch())`
  )
    .bind(
      crypto.randomUUID(), row.companyId, row.userId, row.saleId,
      JSON.stringify({ invoiceNumber: row.invoiceNumber, changes: row.changes }),
      row.ip
    )
    .run();
}

// POST /sales/:id/void — anulación. IDEMPOTENTE: llamarla dos veces devuelve la
// misma respuesta y devuelve el stock UNA sola vez.
sales.post("/:id/void", requireModule("pos"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const result = await voidSale(c.env, db, auth, id, { ip: getClientIp(c) });
  if (!result.ok) {
    return c.json({ ok: false, error: result.error, code: result.code }, result.status as any);
  }
  return c.json({ ok: true, data: result.sale, alreadyVoided: result.alreadyVoided });
});

export default sales;
