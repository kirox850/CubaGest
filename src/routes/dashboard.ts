import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";

const dashboard = new Hono<{ Bindings: Env }>();
dashboard.use("*", authMiddleware);

// GET /dashboard/summary — resumen rápido existente
dashboard.get("/summary", requireModule("dashboard"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");

  const sales = await db.select().from(schema.sales)
    .where(and(eq(schema.sales.companyId, auth.companyId), eq(schema.sales.status, "emitida"))).all();
  const expenses = await db.select().from(schema.expenses)
    .where(eq(schema.expenses.companyId, auth.companyId)).all();
  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).all();

  // Ingresos/gastos por moneda — las monedas NO se convierten entre sí
  const byCurrency: Record<string, { revenue: number; expenses: number }> = {};
  for (const s of sales) {
    const cur = s.currency || "CUP";
    byCurrency[cur] = byCurrency[cur] || { revenue: 0, expenses: 0 };
    byCurrency[cur].revenue += Number(s.total);
  }
  for (const e of expenses) {
    const cur = (e as any).currency || "CUP";
    byCurrency[cur] = byCurrency[cur] || { revenue: 0, expenses: 0 };
    byCurrency[cur].expenses += Number(e.amount);
  }

  const today = new Date().toISOString().split("T")[0];
  const todaySales = sales.filter((s) => s.date === today);
  const dailyTotals: Record<string, number> = {};
  sales.forEach((s) => { dailyTotals[s.date] = (dailyTotals[s.date] || 0) + Number(s.total); });
  const chartDays = Object.entries(dailyTotals).sort(([a], [b]) => a.localeCompare(b)).slice(-7)
    .map(([date, total]) => ({ date, total }));

  const lowStock = products.filter((p) => Number(p.stock) <= Number(p.minStock));

  return c.json({
    ok: true,
    data: {
      byCurrency,
      salesCount: sales.length,
      todaySalesCount: todaySales.length,
      todaySalesTotal: todaySales.reduce((a, s) => a + Number(s.total), 0),
      lowStockCount: lowStock.length,
      lowStock,
      chartDays,
    },
  });
});

// GET /dashboard/analytics — inteligencia de negocio
dashboard.get("/analytics", requireModule("dashboard"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");

  const sales = await db.select().from(schema.sales)
    .where(and(eq(schema.sales.companyId, auth.companyId), eq(schema.sales.status, "emitida"))).all();
  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).all();
  const itemRows = await db.select().from(schema.saleItems)
    .innerJoin(schema.sales, eq(schema.saleItems.saleId, schema.sales.id))
    .where(and(eq(schema.sales.companyId, auth.companyId), eq(schema.sales.status, "emitida"))).all();

  const now = new Date();
  const thisMonth = now.toISOString().slice(0, 7);
  const prevDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonth = prevDate.toISOString().slice(0, 7);

  const thisMonthSales = sales.filter((s) => s.date.slice(0, 7) === thisMonth);
  const prevMonthSales = sales.filter((s) => s.date.slice(0, 7) === prevMonth);
  const itemsFlat: any[] = itemRows.map((r: any) => r.sale_items || r);

  // Ingresos por moneda, mes vs mes — nunca se convierten entre monedas
  const currencies = Array.from(new Set(sales.map((s) => s.currency || "CUP")));
  const revenueByCurrency: Record<string, { thisMonth: number; prevMonth: number; total: number; deltaPct: number | null }> = {};
  for (const cur of currencies) {
    const tm = thisMonthSales.filter((s) => (s.currency || "CUP") === cur).reduce((a, s) => a + Number(s.total), 0);
    const pm = prevMonthSales.filter((s) => (s.currency || "CUP") === cur).reduce((a, s) => a + Number(s.total), 0);
    const tot = sales.filter((s) => (s.currency || "CUP") === cur).reduce((a, s) => a + Number(s.total), 0);
    revenueByCurrency[cur] = {
      thisMonth: tm, prevMonth: pm, total: tot,
      deltaPct: pm > 0 ? Math.round(((tm - pm) / pm) * 1000) / 10 : null,
    };
  }

  // Top 5 productos por ingresos (histórico)
  const byProduct: Record<string, { name: string; qty: number; revenue: number }> = {};
  for (const it of itemsFlat) {
    const key = it.productId || it.name;
    if (!byProduct[key]) byProduct[key] = { name: it.name, qty: 0, revenue: 0 };
    byProduct[key].qty += Number(it.qty);
    byProduct[key].revenue += Number(it.total);
  }
  const topProducts = Object.values(byProduct).sort((a, b) => b.revenue - a.revenue).slice(0, 5);

  // Tendencia de los últimos 30 días (todos los totales mezclados por día,
  // para la curva; el detalle por moneda está arriba)
  const trend30: { date: string; total: number }[] = [];
  const dayMap: Record<string, { date: string; total: number }> = {};
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10);
    dayMap[d] = { date: d, total: 0 };
    trend30.push(dayMap[d]);
  }
  for (const s of sales) {
    const dk = dayMap[s.date];
    if (dk) dk.total += Number(s.total);
  }

  // Productos muertos: activos con stock y sin ninguna venta en 30 días
  const sold30 = new Set(itemsFlat.map((it) => it.productId).filter(Boolean));
  const deadProducts = products
    .filter((p) => !sold30.has(p.id) && Number(p.stock) > 0)
    .map((p) => ({ id: p.id, code: p.code, name: p.name, stock: p.stock, unit: p.unit }))
    .slice(0, 50);

  return c.json({
    ok: true,
    data: {
      thisMonth,
      prevMonth,
      thisMonthCount: thisMonthSales.length,
      prevMonthCount: prevMonthSales.length,
      revenueByCurrency,
      topProducts,
      trend30,
      deadProducts,
    },
  });
});

export default dashboard;
