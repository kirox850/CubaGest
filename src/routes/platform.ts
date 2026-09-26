import { Hono } from "hono";
import { eq, and, desc, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { signToken, verifyToken, generateUUID, SUPPORT_TOKEN_TTL_SECONDS, PLATFORM_TOKEN_TTL_SECONDS } from "../lib/jwt";
import { hashPassword, comparePassword } from "../lib/hash";
import { getClientIp } from "../lib/audit";
import { PLAN_PRICES } from "../middleware/plans";
import { createMiddleware } from "hono/factory";

// ─── PANEL DE PLATAFORMA (super-admin) ───────────────────────────────────────
// Carril completamente separado del login de empresas:
//  - Tabla propia (platform_admins), login propio, token propio con claim
//    type:"platform" que el middleware normal RECHAZA (y viceversa).
//  - Estas son las ÚNICAS rutas autorizadas a consultar datos sin el filtro
//    de companyId — el resto del sistema sigue aislado igual que siempre.
//  - TODA acción queda registrada en platform_audit_logs.

// MRR: se usa la MISMA tabla de precios que cobra QvaPay
// (middleware/plans.ts → PLAN_PRICES: pro 5, empresarial 10 USD).
//
// Antes vivía aquí una segunda constante, PLAN_PRICE_USD (pro 8,
// empresarial 15), que solo servía para este número. Con customers reales el
// panel llegaba a sumar hasta un 60% más de lo que realmente entra: el
// dashboard decía 8 cuando se cobraban 5. Un solo precio, en un solo sitio.
const PLAN_PRICE_USD = PLAN_PRICES;

const platform = new Hono<{ Bindings: Env }>();

// ── Contexto del admin de plataforma ─────────────────────────────────────────
interface PlatformContext { adminId: string; email: string }

declare module "hono" {
  interface ContextVariableMap {
    platformAdmin?: PlatformContext;
  }
}

export const platformAuthMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return c.json({ ok: false, error: "Token no proporcionado" }, 401);
  try {
    // Solo un token de PROPÓSITO "platform". Un access token de empresa (o un
    // refresh) no entra al panel, aunque la firma sea válida: es la otra
    // mitad de la separación de carriles que exige el claim `purpose`.
    const payload = await verifyToken(token, c.env.JWT_SECRET, { expect: ["platform"] });
    if (!payload.adminId) {
      return c.json({ ok: false, error: "Token de plataforma requerido" }, 403);
    }
    c.set("platformAdmin", { adminId: payload.adminId, email: payload.email || "" });
    await next();
  } catch {
    return c.json({ ok: false, error: "Token inválido o expirado" }, 401);
  }
});

// ── Auditoría ────────────────────────────────────────────────────────────────
async function logPlatform(env: Env, adminId: string | null, action: string, entityType: string, entityId: string | null, detail: any, ip: string) {
  await env.DB.prepare(
    `INSERT INTO platform_audit_logs (id, admin_id, action, entity_type, entity_id, detail, ip, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, unixepoch())`
  ).bind(generateUUID(), adminId, action, entityType, entityId, detail ? JSON.stringify(detail) : null, ip || null).run();
}

// ── Rate limit del login del panel (estricto: 5 por IP / 15 min) ────────────
async function platRateLimited(env: Env, ip: string): Promise<boolean> {
  const win = Math.floor(Date.now() / 1000 / (15 * 60));
  const key = `platrl:${ip}:${win}`;
  await env.DB.prepare(
    `INSERT INTO counters (id, value) VALUES (?, 1) ON CONFLICT(id) DO UPDATE SET value = value + 1`
  ).bind(key).run();
  const row = await env.DB.prepare(`SELECT value FROM counters WHERE id = ?`).bind(key).first<{ value: number }>();
  return (row?.value ?? 0) > 5;
}

// ── Login + BOOTSTRAP automático ─────────────────────────────────────────────
// Si la tabla platform_admins está VACÍA, el primer login que se intente en
// /panel CREA la cuenta con el email/contraseña enviados (no hace falta
// consola ni SQL nunca). Después del primer alta, el bootstrap queda
// desactivado para siempre y solo se puede entrar con esa cuenta.
platform.post("/auth/login", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (await platRateLimited(c.env, ip)) {
    return c.json({ ok: false, error: "Demasiados intentos. Espera 15 minutos." }, 429);
  }

  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ email: string; password: string }>().catch(() => ({ email: "", password: "" }));
  const email = (body.email || "").toLowerCase().trim();
  const password = body.password || "";
  if (!email || !password) return c.json({ ok: false, error: "Correo y contraseña requeridos" }, 400);

  const anyAdmin = await db.select({ id: schema.platformAdmins.id }).from(schema.platformAdmins).limit(1).get();

  if (!anyAdmin) {
    // BOOTSTRAP: primer acceso de la historia del panel → crear la cuenta.
    if (password.length < 10) {
      return c.json({ ok: false, error: "La contraseña del panel debe tener al menos 10 caracteres." }, 400);
    }
    const id = generateUUID();
    await db.insert(schema.platformAdmins).values({
      id, email, name: "Admin de Plataforma",
      passwordHash: await hashPassword(password),
    }).catch(() => null);
    await logPlatform(c.env, id, "platform.bootstrap", "platform_admin", id, { email }, ip);
    const token = await signToken({ purpose: "platform", adminId: id, email }, c.env.JWT_SECRET, PLATFORM_TOKEN_TTL_SECONDS);
    return c.json({ ok: true, accessToken: token, admin: { id, email, name: "Admin de Plataforma" }, bootstrapped: true });
  }

  const admin = await db.select().from(schema.platformAdmins).where(eq(schema.platformAdmins.email, email)).get();
  // Mensaje genérico — no revelar si el correo existe en el panel.
  if (!admin || !(await comparePassword(password, admin.passwordHash))) {
    return c.json({ ok: false, error: "Credenciales incorrectas" }, 401);
  }

  await db.update(schema.platformAdmins).set({ lastLoginAt: new Date() }).where(eq(schema.platformAdmins.id, admin.id));
  const token = await signToken({ purpose: "platform", adminId: admin.id, email: admin.email }, c.env.JWT_SECRET, PLATFORM_TOKEN_TTL_SECONDS);
  await logPlatform(c.env, admin.id, "platform.login", "platform_admin", admin.id, null, ip);
  return c.json({ ok: true, accessToken: token, admin: { id: admin.id, email: admin.email, name: admin.name } });
});

platform.use("*", platformAuthMiddleware);

// ── Empresas: lista con métricas por empresa ─────────────────────────────────
platform.get("/companies", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const q = (c.req.query("q") || "").toLowerCase();

  const rows = await db.select().from(schema.companies).orderBy(desc(schema.companies.createdAt)).all();
  const userCounts = await db.select({
    companyId: schema.users.companyId,
    count: sql<number>`count(*)`,
  }).from(schema.users).groupBy(schema.users.companyId).all();
  const salesCounts = await db.select({
    companyId: schema.sales.companyId,
    count: sql<number>`count(*)`,
    last: sql<string>`max(${schema.sales.date})`,
  }).from(schema.sales).groupBy(schema.sales.companyId).all();
  const userMap = new Map(userCounts.map((u) => [u.companyId, u.count]));
  const salesMap = new Map(salesCounts.map((s) => [s.companyId, s]));

  const now = Date.now();
  let list = rows.map((co) => {
    const expiry = co.planExpiry ? new Date(co.planExpiry).getTime() : null;
    const status = !co.active ? "suspendida"
      : co.subscriptionStatus === "failed" ? "pago fallido"
      : co.subscriptionStatus === "trial" && expiry && expiry > now ? "trial"
      : expiry && expiry < now ? "vencida"
      : co.subscriptionStatus === "active" ? "activa" : co.subscriptionStatus;
    return {
      id: co.id, name: co.name, nit: co.nit,
      plan: co.plan, planExpiry: co.planExpiry,
      subscriptionStatus: co.subscriptionStatus, active: co.active,
      paymentMethod: co.paymentMethod, lastPaymentDate: co.lastPaymentDate,
      nextPaymentDate: co.nextPaymentDate, failedAttempts: co.failedAttempts,
      internalNotes: co.internalNotes,
      createdAt: co.createdAt,
      users: userMap.get(co.id) || 0,
      salesTotal: salesMap.get(co.id)?.count || 0,
      lastSaleDate: salesMap.get(co.id)?.last || null,
      effectiveStatus: status,
    };
  });
  if (q) list = list.filter((co) => co.name.toLowerCase().includes(q) || (co.nit || "").includes(q));
  return c.json({ ok: true, data: list });
});

// ── Detalle de empresa ───────────────────────────────────────────────────────
platform.get("/companies/:id", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const id = c.req.param("id");
  const co = await db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  if (!co) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);
  const users = await db.select({
    id: schema.users.id, name: schema.users.name, email: schema.users.email,
    role: schema.users.role, active: schema.users.active, lastLoginAt: schema.users.lastLoginAt,
  }).from(schema.users).where(eq(schema.users.companyId, id)).all();
  const salesAgg = await db.select({
    count: sql<number>`count(*)`,
    last: sql<string>`max(${schema.sales.date})`,
  }).from(schema.sales).where(eq(schema.sales.companyId, id)).get();
  return c.json({
    ok: true, data: {
      company: co, users,
      salesTotal: salesAgg?.count || 0,
      lastSaleDate: salesAgg?.last || null,
      qvapayAuthorized: !!co.qvapayAuthorized,
    },
  });
});

// ── Cambiar plan / regalar extensión ─────────────────────────────────────────
platform.post("/companies/:id/plan", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("platformAdmin")!;
  const id = c.req.param("id");
  const body = await c.req.json<{ plan: "free" | "pro" | "empresarial"; months?: number }>();
  const months = Math.max(0, Math.min(Number(body.months ?? 1), 24));
  const co = await db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  if (!co) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);
  if (!["free", "pro", "empresarial"].includes(body.plan)) return c.json({ ok: false, error: "Plan inválido" }, 400);

  const updates: Partial<typeof schema.companies.$inferInsert> = { plan: body.plan };
  if (body.plan === "free") {
    updates.planExpiry = null;
    updates.subscriptionStatus = "none";
  } else {
    const base = co.planExpiry && new Date(co.planExpiry).getTime() > Date.now() ? new Date(co.planExpiry) : new Date();
    base.setDate(base.getDate() + months * 30);
    updates.planExpiry = base;
    updates.subscriptionStatus = "active";
    updates.failedAttempts = 0;
  }
  await db.update(schema.companies).set(updates).where(eq(schema.companies.id, id));
  await logPlatform(c.env, auth.adminId, "platform.plan.change", "company", id,
    { before: { plan: co.plan, planExpiry: co.planExpiry }, after: updates }, c.req.header("CF-Connecting-IP") || "");
  const updated = await db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  return c.json({ ok: true, data: updated });
});

// ── Suspender / reactivar empresa completa ───────────────────────────────────
platform.post("/companies/:id/status", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("platformAdmin")!;
  const id = c.req.param("id");
  const body = await c.req.json<{ active: boolean }>();
  const co = await db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  if (!co) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);
  await db.update(schema.companies).set({ active: !!body.active }).where(eq(schema.companies.id, id));
  await logPlatform(c.env, auth.adminId, body.active ? "platform.company.activate" : "platform.company.suspend",
    "company", id, { before: { active: co.active } }, c.req.header("CF-Connecting-IP") || "");
  // Efecto: los logins nuevos se bloquean al instante (ver auth.ts);
  // las sesiones ya abiertas mueren al expirar su token (máx. 9h) o al
  // intentar refrescar (el refresh también verifica empresa activa).
  return c.json({ ok: true });
});

// ── Marcar pago recibido a mano (escape hatch de QvaPay) ────────────────────
platform.post("/companies/:id/payment", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("platformAdmin")!;
  const id = c.req.param("id");
  const body = await c.req.json<{ months?: number }>();
  const months = Math.max(1, Math.min(Number(body.months ?? 1), 12));
  const co = await db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  if (!co) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);

  const now = new Date();
  const base = co.planExpiry && new Date(co.planExpiry).getTime() > now.getTime() ? new Date(co.planExpiry) : now;
  base.setDate(base.getDate() + months * 30);
  const next = new Date(base);
  await db.update(schema.companies).set({
    lastPaymentDate: now, nextPaymentDate: next, planExpiry: base,
    subscriptionStatus: "active", failedAttempts: 0, active: true,
  }).where(eq(schema.companies.id, id));
  await logPlatform(c.env, auth.adminId, "platform.payment.manual", "company", id,
    { months, previousExpiry: co.planExpiry, newExpiry: base.toISOString() }, c.req.header("CF-Connecting-IP") || "");
  const updated = await db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  return c.json({ ok: true, data: updated });
});

// ── Notas internas ───────────────────────────────────────────────────────────
platform.put("/companies/:id/notes", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("platformAdmin")!;
  const id = c.req.param("id");
  const body = await c.req.json<{ notes: string }>();
  const co = await db.select({ id: schema.companies.id }).from(schema.companies).where(eq(schema.companies.id, id)).get();
  if (!co) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);
  await db.update(schema.companies).set({ internalNotes: (body.notes || "").slice(0, 4000) }).where(eq(schema.companies.id, id));
  await logPlatform(c.env, auth.adminId, "platform.notes.update", "company", id, null, c.req.header("CF-Connecting-IP") || "");
  return c.json({ ok: true });
});

// ── Entrar como (impersonar) — auditado siempre ─────────────────────────────
platform.post("/companies/:id/impersonate", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("platformAdmin")!;
  const id = c.req.param("id");
  const co = await db.select().from(schema.companies).where(eq(schema.companies.id, id)).get();
  if (!co) return c.json({ ok: false, error: "Empresa no encontrada" }, 404);
  const admin = await db.select().from(schema.users)
    .where(and(eq(schema.users.companyId, id), eq(schema.users.role, "admin"), eq(schema.users.active, true)))
    .orderBy(schema.users.createdAt)
    .get();
  if (!admin) return c.json({ ok: false, error: "Esta empresa no tiene un admin activo" }, 404);

  await logPlatform(c.env, auth.adminId, "platform.impersonate", "company", id,
    { targetUser: admin.email, companyName: co.name }, c.req.header("CF-Connecting-IP") || "");

  // Token REAL de sesión de ese admin (misma forma que el login normal):
  // el panel lo guarda como sesión web y entra a la app como si fuera él.
  // Propósito "support": es un access token de empresa (lo acepta el
  // middleware normal) con vida corta y siempre auditado en
  // platform_audit_logs, no un token normal que se confunda con el del
  // dueño de la cuenta.
  const accessToken = await signToken(
    { purpose: "support", userId: admin.id, companyId: id, role: admin.role },
    c.env.JWT_SECRET, SUPPORT_TOKEN_TTL_SECONDS
  );
  return c.json({
    ok: true, accessToken,
    user: {
      id: admin.id, name: admin.name, email: admin.email, role: admin.role, nit: admin.nit,
      company: {
        id: co.id, name: co.name, defaultCurrency: co.defaultCurrency,
        plan: co.plan, planExpiry: co.planExpiry, trialActive: false,
      },
    },
  });
});

// ── Métricas del negocio ─────────────────────────────────────────────────────
platform.get("/stats", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const now = Date.now();
  const weekAgo = now - 7 * 86400000;
  const rows = await db.select().from(schema.companies).all();
  const active = rows.filter((r) => r.active);
  const paying = active.filter((r) => r.subscriptionStatus === "active" && r.plan !== "free");
  const trials = active.filter((r) => r.subscriptionStatus === "trial" && r.planExpiry && new Date(r.planExpiry).getTime() > now);
  const expiringSoon = active.filter((r) => r.planExpiry && new Date(r.planExpiry).getTime() > now && new Date(r.planExpiry).getTime() < now + 7 * 86400000);
  const failed = active.filter((r) => r.subscriptionStatus === "failed");
  const suspended = rows.filter((r) => !r.active);
  const mrr = paying.reduce((a, r) => a + (PLAN_PRICE_USD[r.plan] || 0), 0);
  return c.json({
    ok: true, data: {
      total: rows.length, active: active.length, suspended: suspended.length,
      paying: paying.length, trials: trials.length, expiringSoon: expiringSoon.length,
      failed: failed.length, mrrUsd: mrr,
    },
  });
});

// ── Auditoría del panel (últimos 200) ────────────────────────────────────────
platform.get("/audit", async (c) => {
  const rows = await c.env.DB.prepare(
    `SELECT a.*, p.email AS adminEmail FROM platform_audit_logs a
     LEFT JOIN platform_admins p ON p.id = a.admin_id
     ORDER BY a.created_at DESC LIMIT 200`
  ).all();
  return c.json({ ok: true, data: rows.results || [] });
});

export default platform;
