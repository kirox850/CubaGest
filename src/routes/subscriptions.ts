import { Hono } from "hono";
import { eq, and, gte, lte, count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireRole } from "../middleware/roles";
import { PLAN_LIMITS, PLAN_PRICES, getPlanInfo } from "../middleware/plans";
import {
  qvapayAuthorizePayments,
  qvapayCharge,
  qvapayComputeHmac,
  decodeQvapayCallbackData,
  QvaPayError,
} from "../lib/qvapay";

const subscriptions = new Hono<{ Bindings: Env }>();

subscriptions.get("/status", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, auth.companyId)).get();
  if (!company) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);
  const effectivePlan = (company.planExpiry && new Date(company.planExpiry) < new Date()) ? "free" : company.plan;
  const daysLeft = company.planExpiry
    ? Math.max(0, Math.ceil((new Date(company.planExpiry).getTime() - Date.now()) / 86400000))
    : null;
  return c.json({
    ok: true,
    data: {
      plan: effectivePlan,
      planExpiry: company.planExpiry,
      subscriptionStatus: company.subscriptionStatus,
      paymentMethod: company.paymentMethod,
      qvapayAuthorized: company.qvapayAuthorized,
      lastPaymentDate: company.lastPaymentDate,
      nextPaymentDate: company.nextPaymentDate,
      failedAttempts: company.failedAttempts,
      daysLeft,
      isTrial: company.subscriptionStatus === "trial",
    },
  });
});

subscriptions.get("/", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const info = await getPlanInfo(db, auth.companyId);
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  const [usersCount, productsCount, salesCount] = await Promise.all([
    db.select({ value: count() }).from(schema.users)
      .where(and(eq(schema.users.companyId, auth.companyId), eq(schema.users.active, true))).then(r => r[0]?.value ?? 0),
    db.select({ value: count() }).from(schema.products)
      .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).then(r => r[0]?.value ?? 0),
    db.select({ value: count() }).from(schema.sales)
      .where(and(eq(schema.sales.companyId, auth.companyId), gte(schema.sales.date, start), lte(schema.sales.date, end))).then(r => r[0]?.value ?? 0),
  ]);
  return c.json({
    ok: true,
    data: {
      ...info,
      usage: { users: usersCount, products: productsCount, salesThisMonth: salesCount },
      allPlans: PLAN_LIMITS,
    },
  });
});

subscriptions.post("/whatsapp", authMiddleware, requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, auth.companyId)).get();
  if (!company) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);
  const plan = (company.planExpiry && new Date(company.planExpiry) < new Date()) ? "free" : company.plan;
  const text = `Hola, soy ${company.name}. Quiero actualizar mi plan de CubaGest a ${plan === "free" ? "Pro" : "Empresarial"}. NIT: ${company.nit || "N/A"}`;
  const url = `https://wa.me/?text=${encodeURIComponent(text)}`;
  return c.json({ ok: true, data: { url } });
});

// POST /subscription/authorize
// Genera la URL de QvaPay para que el admin autorice cobros recurrentes
// directos a favor de esta app. El plan elegido viaja codificado dentro de
// remote_id ("{companyId}:{plan}") para que el callback sepa qué activar.
//
// Requiere que la app de QvaPay tenga habilitado el permiso
// "allowed_payment_auth" (lo activa soporte de QvaPay a pedido).
subscriptions.post("/authorize", authMiddleware, requireRole("admin"), async (c) => {
  const auth = c.get("auth");
  const body = await c.req.json<{ plan?: string }>().catch(() => ({} as { plan?: string }));
  const plan = body.plan;
  if (plan !== "pro" && plan !== "empresarial") {
    return c.json({ ok: false, error: "Plan inválido" }, 400);
  }

  const remoteId = `${auth.companyId}:${plan}`;
  // El callback pasa por el proxy del frontend (/api/...), NO por la URL
  // directa de workers.dev — en Cuba ese dominio está bloqueado por el ISP,
  // así que si QvaPay redirigiera al navegador directo a workers.dev, la
  // redirección se quedaría colgada igual que las llamadas normales de la
  // API. El proxy en functions/api/[[path]].ts reenvía esto al backend real
  // por dentro de la red de Cloudflare.
  const frontendUrl = c.env.APP_URL || "https://cubagest.dpdns.org";
  const callbackUrl = `${frontendUrl}/api/subscription/qvapay-callback`;

  try {
    const result = await qvapayAuthorizePayments(c.env, remoteId, callbackUrl);
    return c.json({ ok: true, data: { url: result.url } });
  } catch (err: any) {
    const status = err instanceof QvaPayError ? err.status : 500;
    return c.json({ ok: false, error: err.message || "No se pudo generar la autorización de QvaPay" }, status as any);
  }
});

// GET /subscription/qvapay-callback
// QvaPay redirige aquí el navegador del usuario luego de autorizar (o
// cancelar) los cobros recurrentes. Esta ruta NO lleva authMiddleware:
// es una redirección de navegador sin el token de sesión de CubaGest, así
// que identificamos la empresa/plan a través de remote_id.
//
// Confirmado con una autorización real en producción (agosto 2026): QvaPay
// NO manda el uuid como query param plano. Manda tres params:
//   - data: JSON en Base64 con { remote_id, user_uuid, user_email,
//     user_name, verified, auth_secret }
//   - token: hex de 64 caracteres, pinta de HMAC-SHA256(app_secret, data)
//   - remote_id: el mismo remote_id, repetido fuera del data.
// ⚠️ La doc oficial de QvaPay (qvapay.com/docs) NO documenta este formato
// de callback ni cómo verificar `token`, así que NO lo usamos para
// bloquear el callback (podría rechazar callbacks legítimos si el
// algoritmo real es distinto al que asumimos). Solo lo logueamos para
// comparar y confirmar con casos reales antes de endurecerlo a un rechazo.
//
// Para el cobro (/v2/charge) la doc oficial confirma que solo hace falta
// user_uuid — el auth_secret del payload se guarda por si acaso, pero no
// se usa en el cobro.
subscriptions.get("/qvapay-callback", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const query = c.req.query();
  const frontendUrl = c.env.APP_URL || "https://cubagest.dpdns.org";

  console.log("QvaPay callback recibido, remote_id:", query.remote_id, "tiene data:", !!query.data, "tiene token:", !!query.token);

  // Verificación NO bloqueante: solo para ir confirmando si nuestra
  // suposición del algoritmo (HMAC-SHA256) es correcta, comparando en los
  // logs. Cuando se confirme en varias pruebas reales, se puede convertir
  // en un rechazo real.
  if (query.data && query.token && c.env.QVAPAY_APP_SECRET) {
    try {
      const computed = await qvapayComputeHmac(c.env.QVAPAY_APP_SECRET, query.data);
      console.log("QvaPay callback: hash calculado coincide con token recibido:", computed === query.token);
    } catch (e) {
      console.error("QvaPay callback: no se pudo calcular el hash de verificación:", e);
    }
  }

  const remoteIdRaw = query.remote_id || "";
  const [companyId, plan] = remoteIdRaw.split(":");

  if (!companyId || (plan !== "pro" && plan !== "empresarial")) {
    console.error("QvaPay callback sin remote_id válido:", remoteIdRaw);
    return c.redirect(`${frontendUrl}/?qvapay=error`, 302);
  }

  if (query.status === "cancelled" || query.status === "denied") {
    return c.redirect(`${frontendUrl}/?qvapay=cancelled`, 302);
  }

  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
  if (!company) return c.redirect(`${frontendUrl}/?qvapay=error`, 302);

  if (!query.data) {
    console.error("QvaPay callback sin `data`, no se puede procesar la autorización");
    return c.redirect(`${frontendUrl}/?qvapay=error`, 302);
  }

  const payload = decodeQvapayCallbackData(query.data);
  if (!payload || !payload.user_uuid) {
    console.error("QvaPay callback con data decodificable pero sin user_uuid");
    return c.redirect(`${frontendUrl}/?qvapay=authorized&pending=1`, 302);
  }

  await db.update(schema.companies).set({
    paymentMethod: "qvapay",
    qvapayAuthorized: true,
    qvapayUserUuid: payload.user_uuid,
    qvapayAuthSecret: payload.auth_secret || null,
  }).where(eq(schema.companies.id, companyId));

  const amount = PLAN_PRICES[plan];
  try {
    await qvapayCharge(c.env, {
      amount,
      userUuid: payload.user_uuid,
      description: `CubaGest — Plan ${plan === "pro" ? "Pro" : "Empresarial"} (mensual)`,
      remoteId: `${companyId}:${plan}:${Date.now()}`,
    });
    const nextPaymentDate = new Date(Date.now() + 30 * 24 * 3600 * 1000);
    await db.update(schema.companies).set({
      plan,
      planExpiry: nextPaymentDate,
      subscriptionStatus: "active",
      lastPaymentDate: new Date(),
      nextPaymentDate,
      failedAttempts: 0,
    }).where(eq(schema.companies.id, companyId));
    // Programa de referidos: si esta empresa fue referida, el referente
    // recibe el MISMO plan de regalo 30 días (una vez por referido).
    try {
      const { applyReferralBonusOnPayment } = await import("./referrals");
      await applyReferralBonusOnPayment(db, c.env, companyId, plan);
    } catch (e) {
      console.error("referral bonus fallo (no bloquea el pago):", e);
    }
    return c.redirect(`${frontendUrl}/?qvapay=activated`, 302);
  } catch (err: any) {
    console.error("QvaPay: fallo el cobro inicial tras autorización:", err.message);
    return c.redirect(`${frontendUrl}/?qvapay=charge_failed`, 302);
  }
});

// Cobro recurrente diario — invocado desde el cron trigger en src/index.ts.
// Revisa todas las empresas con QvaPay autorizado cuyo nextPaymentDate ya
// venció y les cobra el precio de su plan actual.
export async function renewQvapaySubscriptions(env: Env) {
  const db = drizzle(env.DB, { schema });
  const now = new Date();

  const candidates = await db.select().from(schema.companies)
    .where(and(
      eq(schema.companies.paymentMethod, "qvapay"),
      eq(schema.companies.qvapayAuthorized, true),
    )).all();

  for (const company of candidates) {
    if (!company.nextPaymentDate || new Date(company.nextPaymentDate) > now) continue;
    if (!company.qvapayUserUuid) continue;
    if (company.plan === "free") continue;

    const amount = PLAN_PRICES[company.plan];
    try {
      await qvapayCharge(env, {
        amount,
        userUuid: company.qvapayUserUuid,
        description: `CubaGest — Renovación plan ${company.plan === "pro" ? "Pro" : "Empresarial"}`,
        remoteId: `${company.id}:${company.plan}:${Date.now()}`,
      });
      const nextPaymentDate = new Date(now.getTime() + 30 * 24 * 3600 * 1000);
      await db.update(schema.companies).set({
        planExpiry: nextPaymentDate,
        subscriptionStatus: "active",
        lastPaymentDate: now,
        nextPaymentDate,
        failedAttempts: 0,
      }).where(eq(schema.companies.id, company.id));
      // Referidos: por si el vínculo se creó después del primer pago
      try {
        const { applyReferralBonusOnPayment } = await import("./referrals");
        await applyReferralBonusOnPayment(db, env, company.id, company.plan);
      } catch { /* no bloquea la renovación */ }
    } catch (err: any) {
      const failedAttempts = (company.failedAttempts || 0) + 1;
      console.error(`QvaPay: fallo la renovación de ${company.id}:`, err.message);
      await db.update(schema.companies).set({
        subscriptionStatus: "failed",
        failedAttempts,
      }).where(eq(schema.companies.id, company.id));
    }
  }
}

export default subscriptions;
