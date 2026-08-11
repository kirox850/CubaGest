import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";

const invoices = new Hono<{ Bindings: Env }>();

invoices.use("*", authMiddleware);

invoices.get("/:id", requireModule("facturacion"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const sale = await db.select().from(schema.sales)
    .where(and(eq(schema.sales.id, id), eq(schema.sales.companyId, auth.companyId))).get();
  if (!sale) return c.json({ ok: false, error: "Factura no encontrada" }, 404);

  const items = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, sale.id)).all();
  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, auth.companyId)).get();

  return c.json({
    ok: true,
    data: {
      ...sale,
      items,
      companyName: company?.name,
      companyNit: company?.nit,
    },
  });
});

invoices.get("/:id/pdf-data", requireModule("facturacion"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const sale = await db.select().from(schema.sales)
    .where(and(eq(schema.sales.id, id), eq(schema.sales.companyId, auth.companyId))).get();
  if (!sale) return c.json({ ok: false, error: "Factura no encontrada" }, 404);

  const items = await db.select().from(schema.saleItems).where(eq(schema.saleItems.saleId, sale.id)).all();
  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, auth.companyId)).get();

  return c.json({
    ok: true,
    data: {
      invoiceNumber: sale.invoiceNumber,
      date: sale.date,
      company: { name: company?.name, nit: company?.nit, address: null },
      client: { name: sale.clientName, nit: sale.clientNit, phone: sale.clientPhone },
      items: items.map(i => ({
        name: i.name,
        qty: i.qty,
        unitPrice: i.price,
        total: i.total,
      })),
      subtotal: sale.subtotal,
      tax: sale.tax,
      total: sale.total,
      currency: sale.currency,
      payMethod: sale.payMethod,
      status: sale.status,
    },
  });
});

export default invoices;
