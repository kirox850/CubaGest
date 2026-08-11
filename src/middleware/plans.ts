import { createMiddleware } from "hono/factory";
import { eq, and, gte, lt, count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";

const PLAN_LIMITS: Record<string, { maxUsers: number | null; maxProducts: number | null; maxSalesMonth: number | null; historyDays: number | null }> = {
  free:        { maxUsers: 1,    maxProducts: 10,   maxSalesMonth: 100,  historyDays: 30 },
  pro:         { maxUsers: 3,    maxProducts: 50,   maxSalesMonth: 1000, historyDays: 365 },
  empresarial: { maxUsers: null, maxProducts: null, maxSalesMonth: null, historyDays: null },
};

export { PLAN_LIMITS };

function getEffectivePlan(company: typeof schema.companies.$inferSelect): string {
  if (company.planExpiry && new Date(company.planExpiry) < new Date()) {
    return "free";
  }
  return company.plan || "free";
}

export async function loadPlan(db: ReturnType<typeof drizzle>, companyId: string) {
  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
  if (!company) throw new Error("Empresa no encontrada");
  const planKey = getEffectivePlan(company);
  const planData = PLAN_LIMITS[planKey];
  return { company, planKey, planData };
}

export function checkLimit(resource: "users" | "products" | "sales") {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const db = drizzle(c.env.DB, { schema });
    const { companyId } = c.get("auth");
    const { planData, planKey } = await loadPlan(db, companyId);

    if (resource === "users") {
      if (planData.maxUsers === null) return next();
      const cnt = await db.select({ value: count() }).from(schema.users)
        .where(and(eq(schema.users.companyId, companyId), eq(schema.users.active, true))).get();
      if ((cnt?.value ?? 0) >= planData.maxUsers) {
        return c.json({
          ok: false,
          error: `Tu plan ${planKey} permite máximo ${planData.maxUsers} usuario(s). Actualiza tu plan para agregar más.`,
          code: "PLAN_LIMIT_USERS", currentPlan: planKey, limit: planData.maxUsers, current: cnt?.value ?? 0,
        }, 403);
      }
    } else if (resource === "products") {
      if (planData.maxProducts === null) return next();
      const cnt = await db.select({ value: count() }).from(schema.products)
        .where(and(eq(schema.products.companyId, companyId), eq(schema.products.active, true))).get();
      if ((cnt?.value ?? 0) >= planData.maxProducts) {
        return c.json({
          ok: false,
          error: `Tu plan ${planKey} permite máximo ${planData.maxProducts} producto(s) activos. Actualiza tu plan para agregar más.`,
          code: "PLAN_LIMIT_PRODUCTS", currentPlan: planKey, limit: planData.maxProducts, current: cnt?.value ?? 0,
        }, 403);
      }
    } else if (resource === "sales") {
      if (planData.maxSalesMonth === null) return next();
      const now = new Date();
      const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
      const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
      const cnt = await db.select({ value: count() }).from(schema.sales)
        .where(and(
          eq(schema.sales.companyId, companyId),
          gte(schema.sales.date, start),
          lt(schema.sales.date, end),
        )).get();
      if ((cnt?.value ?? 0) >= planData.maxSalesMonth) {
        return c.json({
          ok: false,
          error: `Tu plan ${planKey} permite máximo ${planData.maxSalesMonth} ventas al mes. Has alcanzado el límite de este mes. Actualiza tu plan para continuar.`,
          code: "PLAN_LIMIT_SALES", currentPlan: planKey, limit: planData.maxSalesMonth, current: cnt?.value ?? 0,
        }, 403);
      }
    }

    await next();
  });
}

export async function getPlanInfo(db: ReturnType<typeof drizzle>, companyId: string) {
  const { company, planKey, planData } = await loadPlan(db, companyId);
  return {
    plan: planKey,
    planLabel: planKey === "free" ? "Free" : planKey === "pro" ? "Pro" : "Empresarial",
    planExpiry: company.planExpiry,
    expired: company.planExpiry ? new Date(company.planExpiry) < new Date() : false,
    limits: {
      maxUsers: planData.maxUsers,
      maxProducts: planData.maxProducts,
      maxSalesMonth: planData.maxSalesMonth,
      historyDays: planData.historyDays,
    },
  };
}
