import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireRole } from "../middleware/roles";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";

const referrals = new Hono<{ Bindings: Env }>();

referrals.use("*", authMiddleware);

// ── Lógica de bonus (exportada para engancharla al cobro de QvaPay) ─────────
// Se llama cuando la empresa referida paga un plan (autorización inicial o
// renovación). El referente recibe EL MISMO PLAN de regalo por 30 días.
// "Solo una vez por cada referido": la fila pasa a 'bonificado' y no vuelve
// a dispararse. "Distintos referidos se acumulan": cada bonus suma 30 días
// sobre el expiry vigente del referente.
export async function applyReferralBonusOnPayment(
  db: ReturnType<typeof drizzle>,
  env: Env,
  referredCompanyId: string,
  purchasedPlan: string,
): Promise<boolean> {
  if (purchasedPlan !== "pro" && purchasedPlan !== "empresarial") return false;

  const ref = await db.select().from(schema.referrals)
    .where(and(
      eq(schema.referrals.referredCompanyId, referredCompanyId),
      eq(schema.referrals.status, "pendiente"),
    )).get();
  if (!ref) return false;

  const referrer = await db.select().from(schema.companies)
    .where(eq(schema.companies.id, ref.referrerCompanyId)).get();
  if (!referrer) return false;

  // El regalo se acumula sobre el expiry actual (si sigue vigente) o sobre
  // hoy si ya venció — nunca resta días al referente.
  const currentExpiry = referrer.planExpiry ? new Date(referrer.planExpiry as any) : null;
  const base = currentExpiry && currentExpiry > new Date() ? currentExpiry : new Date();
  const bonusUntil = new Date(base.getTime() + 30 * 24 * 3600 * 1000);

  await db.update(schema.companies).set({
    plan: purchasedPlan as any,
    planExpiry: bonusUntil,
    subscriptionStatus: "active",
  }).where(eq(schema.companies.id, referrer.id));

  await db.update(schema.referrals).set({
    status: "bonificado",
    bonusPlan: purchasedPlan,
    bonusUntil,
    bonifiedAt: new Date(),
  }).where(eq(schema.referrals.id, ref.id));

  try {
    const { logAudit } = await import("../lib/audit");
    await logAudit(env, {
      companyId: referrer.id, userId: null,
      action: "referral.bonus", entity: "referral", entityId: ref.id,
      detail: { referredCompanyId, plan: purchasedPlan, bonusUntil: bonusUntil.toISOString() },
      ip: null,
    });
  } catch {
    // el log de auditoría no debe romper el bonus
  }

  return true;
}

// ── GET /referrals — mi código + listado + estadísticas (admin) ─────────────
referrals.get("/", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");

  const me = await db.select().from(schema.companies)
    .where(eq(schema.companies.id, auth.companyId)).get();
  if (!me) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);

  const list = await db.select().from(schema.referrals)
    .where(eq(schema.referrals.referrerCompanyId, auth.companyId)).all();

  const enriched = [];
  for (const r of list) {
    const referred = await db.select().from(schema.companies)
      .where(eq(schema.companies.id, r.referredCompanyId)).get();
    enriched.push({
      ...r,
      referredCompanyName: referred?.name || "—",
      referredCreatedAt: referred?.createdAt || null,
    });
  }

  return c.json({
    ok: true,
    data: {
      code: me.referralCode || null,
      invited: enriched.length,
      bonified: enriched.filter((r) => r.status === "bonificado").length,
      pending: enriched.filter((r) => r.status === "pendiente").length,
      referrals: enriched,
    },
  });
});

// ── POST /referrals/link — vincular mi empresa a un código de referido ──────
// Para empresas que se registraron sin poner código (solo se puede una vez).
referrals.post("/link", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ code?: string }>();
  const code = (body.code || "").trim().toUpperCase();
  if (!code) return c.json({ ok: false, error: "Código requerido" }, 400);

  const me = await db.select().from(schema.companies)
    .where(eq(schema.companies.id, auth.companyId)).get();
  if (!me) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);
  if (me.referredBy) return c.json({ ok: false, error: "Tu empresa ya tiene un referido vinculado" }, 409);

  const referrer = await db.select().from(schema.companies)
    .where(eq(schema.companies.referralCode, code)).get();
  if (!referrer) return c.json({ ok: false, error: "Código de referido no válido" }, 404);
  if (referrer.id === me.id) return c.json({ ok: false, error: "No puedes referirte a ti mismo" }, 400);

  await db.update(schema.companies).set({ referredBy: referrer.id })
    .where(eq(schema.companies.id, me.id));
  await db.insert(schema.referrals).values({
    id: generateUUID(),
    referrerCompanyId: referrer.id,
    referredCompanyId: me.id,
    status: "pendiente",
  });

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "referral.link", entity: "referral", entityId: referrer.id,
    detail: { code },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: { referrerName: referrer.name } }, 201);
});

export default referrals;
