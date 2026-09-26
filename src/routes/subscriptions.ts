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
  classifyChargeFailure,
  QvaPayError,
} from "../lib/qvapay";

const subscriptions = new Hono<{ Bindings: Env }>();

// Ventana de validez de un `state` de autorización (0008). Diez minutos
// dan de sobra para que el admin pague en QvaPay y vuelva, y acotan lo que
// sirve un state robado de un log o de una URL compartida.
const AUTH_STATE_TTL_MS = 10 * 60 * 1000;

// Ritmo del cron de renovaciones. La doc de QvaPay dice 5 peticiones cada 20
// segundos por app: 4000 ms entre cobros = 5 en 20 s con margen. Y 25 cobros
// por corrida son ~100 s, muy por debajo de los 15 minutos del cron: si hay
// más clientes vencidos, el resto entra en la corrida siguiente (empezando
// siempre por los más vencidos, para que ninguno se quede esperando para
// siempre).
const RENEWAL_DELAY_MS = 4000;
const RENEWAL_BATCH_PER_RUN = 25;

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
// directos a favor de esta app. El plan elegido viaja en una fila de
// payment_authorizations (0008) y a QvaPay solo se le manda el `state`
// (256 bits aleatorios). El callback resuelve empresa y plan desde esa fila,
// nunca desde la URL — ver la nota larga del callback abajo.
//
// Requiere que la app de QvaPay tenga habilitado el permiso
// "allowed_payment_auth" (lo activa soporte de QvaPay a pedido).
subscriptions.post("/authorize", authMiddleware, requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ plan?: string }>().catch(() => ({} as { plan?: string }));
  const plan = body.plan;
  if (plan !== "pro" && plan !== "empresarial") {
    return c.json({ ok: false, error: "Plan inválido" }, 400);
  }

  // 512 bits en hexadecimal, generados con la CSPRNG de Web Crypto (no con
  // Math.random). Sin `state` no existe forma de adivinar el remote_id.
  const state = new Uint8Array(32);
  crypto.getRandomValues(state);
  const remoteId = Array.from(state, (b) => b.toString(16).padStart(2, "0")).join("");

  await db.insert(schema.paymentAuthorizations).values({
    state: remoteId,
    companyId: auth.companyId,
    plan,
    userId: auth.userId,
    status: "pending",
    expiresAt: new Date(Date.now() + AUTH_STATE_TTL_MS),
  });

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
    // QvaPay no devolvió URL, así que este state nunca salió de aquí: se
    // borra para no dejar filas muertas.
    await db.delete(schema.paymentAuthorizations).where(eq(schema.paymentAuthorizations.state, remoteId));
    const status = err instanceof QvaPayError ? err.status : 500;
    return c.json({ ok: false, error: err.message || "No se pudo generar la autorización de QvaPay" }, status as any);
  }
});

// GET /subscription/qvapay-callback
// QvaPay redirige aquí el navegador del usuario luego de autorizar (o
// cancelar) los cobros recurrentes. Esta ruta NO lleva authMiddleware: es una
// redirección de navegador sin el token de sesión de CubaGest.
//
// QUÉ ES LA AUTENTICIDAD DE ESTA RUTA (y por qué)
// Hasta 0008 el `remote_id` era "<companyId>:<plan>" en claro, y esta ruta
// leía empresa y plan de la URL. Eso convertía la ruta en algo que cualquiera
// con el id de una empresa podía invocar para activarle un plan pagado o
// cambiarle el user_uuid (que es a quién se le cobra cada mes). La firma que
// manda QvaPay se calculaba, pero no se comparaba, y el bloque que la calculaba
// ni se ejecutaba sin `token`.
//
// Ahora `remote_id` es el `state` de una fila de payment_authorizations:
// 256 bits de crypto.getRandomValues que genera el propio admin al pulsar
// "Activar plan", de un solo uso y con 10 minutos de caducidad. Aquí se
// resuelve la empresa y el plan DESDE LA BASE DE DATOS. Sin ese state no hay
// callback válido, y las empresas ya autorizadas (que no pasan por aquí) siguen
// cobrándose con normalidad desde el cron.
//
// FORMATO OBSERVADO (autorización real en producción, logs del 2026-09-26):
//   - data:  JSON en Base64 { remote_id, user_uuid, user_email, user_name,
//           verified, auth_secret }
//   - token: 64 hex = HMAC-SHA256(app_secret, data) → CONFIRMADO que coincide
//   - remote_id: el mismo state, repetido fuera del data.
// El token se sigue calculando y logueando como alerta, pero NO bloquea: la
// doc oficial de QvaPay no documenta este formato, así que un rechazo basado
// en él rompería todas las suscripciones nuevas si QvaPay lo cambiara. La
// garantía real es el state, que no depende de nada externo.
//
// Para el cobro (/v2/charge) la doc oficial confirma que solo hace falta
// user_uuid — el auth_secret se guarda por si acaso, pero no se usa.
subscriptions.get("/qvapay-callback", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const query = c.req.query();
  const frontendUrl = c.env.APP_URL || "https://cubagest.dpdns.org";
  const state = query.remote_id || "";

  // Alerta de firma (no bloqueante). Se queda así a propósito: ver la nota
  // larga en lib/qvapay.ts.
  let hmacOk: boolean | null = null;
  if (query.data && query.token && c.env.QVAPAY_APP_SECRET) {
    try {
      hmacOk = (await qvapayComputeHmac(c.env.QVAPAY_APP_SECRET, query.data)) === query.token;
      if (!hmacOk) console.warn("QvaPay callback: la firma NO coincide (revisar estado de QvaPay)");
    } catch (e) {
      console.error("QvaPay callback: no se pudo calcular el hash de verificación:", e);
    }
  }

  // ── 1) Resolver la empresa desde el state, NUNCA desde la URL ─────────────
  const authz = state
    ? await db.select().from(schema.paymentAuthorizations)
        .where(eq(schema.paymentAuthorizations.state, state)).get()
    : undefined;

  if (!authz) {
    console.warn("QvaPay callback con remote_id desconocido o inventado; se ignora.");
    return c.redirect(`${frontendUrl}/?qvapay=error`, 302);
  }
  const companyId = authz.companyId;
  const plan = authz.plan;

  // Reutilización o caducidad. Un state ya usado significa que alguien
  // refrescó la página de QvaPay: no se cobra dos veces, se responde con lo
  // que realmente pasó la primera vez.
  if (authz.status === "charged") return c.redirect(`${frontendUrl}/?qvapay=activated`, 302);
  if (authz.status === "failed") return c.redirect(`${frontendUrl}/?qvapay=charge_failed`, 302);
  if (authz.status === "charging") {
    console.error("QvaPay callback: autorización a medio cobrar (posible recarga de la página)");
    return c.redirect(`${frontendUrl}/?qvapay=charge_failed`, 302);
  }
  if (new Date(authz.expiresAt).getTime() < Date.now()) {
    await db.update(schema.paymentAuthorizations)
      .set({ status: "failed", error: "caducada", completedAt: new Date() })
      .where(eq(schema.paymentAuthorizations.state, state));
    return c.redirect(`${frontendUrl}/?qvapay=error`, 302);
  }

  if (query.status === "cancelled" || query.status === "denied") {
    await db.update(schema.paymentAuthorizations)
      .set({ status: "failed", error: "cancelada por el usuario", completedAt: new Date() })
      .where(eq(schema.paymentAuthorizations.state, state));
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

  // `verified` se REGISTRA, no se exige: su significado no está documentado
  // (ver lib/qvapay.ts) y rechazarlo podría tumbar pagos legítimos.
  console.log("QvaPay callback:", JSON.stringify({
    companyId, plan, hmacOk,
    verified: payload.verified, userUuid: payload.user_uuid,
  }));

  // ── 2) COBRAR ANTES DE ESCRIBIR NADA EN LA EMPRESA ────────────────────────
  // Antes esta ruta escribía qvapayAuthorized=true con el user_uuid nuevo y
  // LUEGO cobraba; si el cobro fallaba, la empresa quedaba marcada como
  // autorizada para siempre (y el cron la cobraría en el futuro sin que
  // nadie hubiera pagado nunca). Primero se marca "charging" en la fila del
  // state —no en la empresa— y solo si el cobro responde bien se escribe la
  // suscripción completa.
  await db.update(schema.paymentAuthorizations)
    .set({ status: "charging", qvapayUserUuid: payload.user_uuid })
    .where(eq(schema.paymentAuthorizations.state, state));

  const amount = PLAN_PRICES[plan];
  try {
    await qvapayCharge(c.env, {
      amount,
      userUuid: payload.user_uuid,
      description: `CubaGest — Plan ${plan === "pro" ? "Pro" : "Empresarial"} (mensual)`,
      remoteId: state,
    });
  } catch (err: any) {
    // Cobro no aplicado. La empresa queda EXACTAMENTE como estaba: sin
    // qvapayAuthorized, sin user_uuid, sin plan. El admin puede reintentar
    // ("Activar plan" genera un state nuevo).
    console.error("QvaPay: fallo el cobro inicial tras autorización:", err.message);
    await db.update(schema.paymentAuthorizations)
      .set({ status: "failed", error: err.message || "error desconocido", completedAt: new Date() })
      .where(eq(schema.paymentAuthorizations.state, state));
    return c.redirect(`${frontendUrl}/?qvapay=charge_failed`, 302);
  }

  // Cobro OK → ahora sí, la empresa queda suscrita.
  const nextPaymentDate = new Date(Date.now() + 30 * 24 * 3600 * 1000);
  await db.update(schema.companies).set({
    paymentMethod: "qvapay",
    qvapayAuthorized: true,
    qvapayUserUuid: payload.user_uuid,
    qvapayAuthSecret: payload.auth_secret || null,
    plan,
    planExpiry: nextPaymentDate,
    subscriptionStatus: "active",
    lastPaymentDate: new Date(),
    nextPaymentDate,
    failedAttempts: 0,
  }).where(eq(schema.companies.id, companyId));

  await db.update(schema.paymentAuthorizations)
    .set({ status: "charged", completedAt: new Date() })
    .where(eq(schema.paymentAuthorizations.state, state));

  // Programa de referidos: si esta empresa fue referida, el referente
  // recibe el MISMO plan de regalo 30 días (una vez por referido).
  try {
    const { applyReferralBonusOnPayment } = await import("./referrals");
    await applyReferralBonusOnPayment(db, c.env, companyId, plan);
  } catch (e) {
    console.error("referral bonus fallo (no bloquea el pago):", e);
  }
  return c.redirect(`${frontendUrl}/?qvapay=activated`, 302);
});

// Cobro recurrente diario — invocado desde el cron trigger en src/index.ts.
// Revisa las empresas con QvaPay autorizado cuya renovación ya venció.
//
// TRES REGLAS QUE NO SON COSMÉTICAS (ver RENEWAL_* arriba):
//  1. La doc de QvaPay limita /v2/charge a 5 peticiones cada 20 s por app.
//     Antes el bucle disparaba todos los cobros seguidos, así que a partir del
//     sexto cliente QvaPay respondía 429 y ese catch marcaba
//     subscriptionStatus='failed' — el cliente perdía el plan sin que nadie
//     le hubiera rechazado el pago. Ahora hay pausa entre cobros.
//  2. Un 429 (o un 5xx, o un fallo de red) NO es un cliente que debe nada:
//     se salta y se reintenta en la próxima corrida, sin tocar su estado.
//  3. Se cobra como máximo RENEWAL_BATCH_PER_RUN por corrida, empezando por
//     los más vencidos, para que nadie quede siempre al final de la cola
//     (con muchos clientes, los últimos se saltarían días seguidos).
export async function renewQvapaySubscriptions(env: Env) {
  const db = drizzle(env.DB, { schema });
  const now = new Date();

  const all = await db.select().from(schema.companies)
    .where(and(
      eq(schema.companies.paymentMethod, "qvapay"),
      eq(schema.companies.qvapayAuthorized, true),
    )).all();

  const candidates = all
    .filter((c) => c.nextPaymentDate && new Date(c.nextPaymentDate) <= now)
    .filter((c) => !!c.qvapayUserUuid && c.plan !== "free")
    // El más vencido primero: si hay más de los que caben en una corrida, el
    // que más días lleva sin cobrar es el primero.
    .sort((a, b) => new Date(a.nextPaymentDate!).getTime() - new Date(b.nextPaymentDate!).getTime())
    .slice(0, RENEWAL_BATCH_PER_RUN);

  if (candidates.length === 0) return;
  console.log(`QvaPay: ${candidates.length} renovaciones vencidas (de ${all.length} empresas autorizadas)`);

  let done = 0;
  for (const company of candidates) {
    // La pausa va entre cobros, no antes del primero: así una sola renovación
    // no espera sin motivo. No consume CPU (setTimeout no lo usa), solo reloj
    // de pared, y el cron de Cloudflare tiene 15 minutos.
    if (done > 0) await new Promise((r) => setTimeout(r, RENEWAL_DELAY_MS));
    done += 1;

    const amount = PLAN_PRICES[company.plan];
    try {
      await qvapayCharge(env, {
        amount,
        userUuid: company.qvapayUserUuid,
        description: `CubaGest — Renovación plan ${company.plan === "pro" ? "Pro" : "Empresarial"}`,
        remoteId: `${company.id}:${company.plan}:${now.getTime()}`,
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
      const outcome = classifyChargeFailure(err);
      if (outcome === "retry_later") {
        // No se ha cobrado nada y no es culpa del cliente: se deja tal cual
        // y se reintenta mañana. Marcarlo "failed" aquí era lo que degradaba
        // a clientes que sí pagaban bien.
        console.warn(`QvaPay: renovación de ${company.id} aplazada (${err.status ?? "sin status"}: ${err.message}). Sin tocar su suscripción.`);
        continue;
      }
      const failedAttempts = (company.failedAttempts || 0) + 1;
      console.error(`QvaPay: cobro rechazado de verdad para ${company.id}:`, err.message);
      await db.update(schema.companies).set({
        subscriptionStatus: "failed",
        failedAttempts,
      }).where(eq(schema.companies.id, company.id));
    }
  }
}

export default subscriptions;
