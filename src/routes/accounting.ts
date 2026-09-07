import { Hono } from "hono";
import { eq, and, gte, lte } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";

const accounting = new Hono<{ Bindings: Env }>();

accounting.use("*", authMiddleware);

accounting.get("/summary", requireModule("contabilidad"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { from, to } = c.req.query();

  let saleConditions: any[] = [eq(schema.sales.companyId, auth.companyId), eq(schema.sales.status, "emitida")];
  let expenseConditions: any[] = [eq(schema.expenses.companyId, auth.companyId)];

  if (from) {
    saleConditions.push(gte(schema.sales.date, from));
    expenseConditions.push(gte(schema.expenses.date, from));
  }
  if (to) {
    saleConditions.push(lte(schema.sales.date, to));
    expenseConditions.push(lte(schema.expenses.date, to));
  }

  const sales = await db.select().from(schema.sales).where(and(...saleConditions)).all();
  const expenses = await db.select().from(schema.expenses).where(and(...expenseConditions)).all();

  const totalRevenue = sales.reduce((a, s) => a + Number(s.total), 0);
  const totalExpenses = expenses.reduce((a, e) => a + Number(e.amount), 0);
  const netProfit = totalRevenue - totalExpenses;

  return c.json({
    ok: true,
    data: {
      totalRevenue,
      totalExpenses,
      netProfit,
      salesCount: sales.length,
      expensesCount: expenses.length,
      period: { from: from || null, to: to || null },
    },
  });
});

accounting.get("/income", requireModule("contabilidad"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { from, to } = c.req.query();

  let conditions: any[] = [eq(schema.sales.companyId, auth.companyId), eq(schema.sales.status, "emitida")];
  if (from) conditions.push(gte(schema.sales.date, from));
  if (to) conditions.push(lte(schema.sales.date, to));

  const rows = await db.select().from(schema.sales).where(and(...conditions)).orderBy(schema.sales.date).all();
  return c.json({ ok: true, data: rows });
});

accounting.get("/expenses", requireModule("contabilidad"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { from, to, category } = c.req.query();

  let conditions: any[] = [eq(schema.expenses.companyId, auth.companyId)];
  if (category) conditions.push(eq(schema.expenses.category, category));
  if (from) conditions.push(gte(schema.expenses.date, from));
  if (to) conditions.push(lte(schema.expenses.date, to));

  const rows = await db.select().from(schema.expenses).where(and(...conditions)).orderBy(schema.expenses.date).all();
  return c.json({ ok: true, data: rows });
});

accounting.post("/expenses", requireModule("contabilidad"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ date: string; concept: string; amount: number; category?: string; method: string }>();
  const { date, concept, amount, category, method } = body;

  if (!date || !concept || !amount || !method) {
    return c.json({ ok: false, error: "date, concept, amount y method son requeridos" }, 400);
  }

  const expense = await db.insert(schema.expenses).values({
    id: generateUUID(),
    companyId: auth.companyId,
    userId: auth.userId,
    date, concept, amount,
    category: category || "Otros",
    method: method as any,
  }).returning().get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "expense.create", entity: "expense", entityId: expense.id,
    detail: { concept, amount, category: category || "Otros" },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: expense }, 201);
});

accounting.put("/expenses/:id", requireModule("contabilidad"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const existing = await db.select().from(schema.expenses)
    .where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, auth.companyId))).get();
  if (!existing) return c.json({ ok: false, error: "Gasto no encontrado" }, 404);

  const body = await c.req.json<Partial<typeof schema.expenses.$inferInsert>>();
  const updates: Partial<typeof schema.expenses.$inferInsert> = {};
  for (const f of ["date", "concept", "amount", "category", "method"] as const) {
    if (body[f] !== undefined) (updates as any)[f] = body[f];
  }

  await db.update(schema.expenses).set(updates).where(eq(schema.expenses.id, id));
  const updated = await db.select().from(schema.expenses).where(eq(schema.expenses.id, id)).get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "expense.update", entity: "expense", entityId: id,
    detail: { before: { concept: existing.concept, amount: existing.amount }, changes: updates },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: updated });
});

accounting.delete("/expenses/:id", requireModule("contabilidad"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const existing = await db.select().from(schema.expenses)
    .where(and(eq(schema.expenses.id, id), eq(schema.expenses.companyId, auth.companyId))).get();
  if (!existing) return c.json({ ok: false, error: "Gasto no encontrado" }, 404);

  await db.delete(schema.expenses).where(eq(schema.expenses.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "expense.delete", entity: "expense", entityId: id,
    detail: { concept: existing.concept, amount: existing.amount },
    ip: getClientIp(c),
  });

  return c.json({ ok: true });
});

export default accounting;
