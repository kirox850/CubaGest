import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireRole } from "../middleware/roles";
import { logAudit, getClientIp } from "../lib/audit";

const settings = new Hono<{ Bindings: Env }>();

settings.use("*", authMiddleware);

// ── Monedas soportadas ───────────────────────────────────────────────────────
// CUP es la base obligatoria; el resto son monedas "fuertes" que la empresa
// puede operar. El admin las selecciona en el menú de perfil (solo admin) y
// TODO el negocio (productos, ventas, contabilidad) se limita a esa lista.
export const SUPPORTED_CURRENCIES = ["CUP", "USD", "MLC", "EUR", "CLASICA"] as const;
export type CurrencyCode = (typeof SUPPORTED_CURRENCIES)[number];

// ── elToque: tasa de cambio con caché de 5 minutos ──────────────────────────
// Nunca le preguntamos a elToque en cada venta: la venta lee SIEMPRE de
// nuestra DB (company_settings.eltoque_rates). Un refresco cada 5 minutos
// como máximo mantiene el rate-limit de elToque tranquilo y las ventas
// instantáneas incluso si elToque está caído (usamos el último valor).
const ELTOQUE_TTL_MS = 5 * 60 * 1000;

// La API de elToque no tiene contrato público documentado y estable; la URL
// es configurable por si hay que ajustarla sin redeploy de código.
function elToqueUrl(env: Env): string {
  return (env as any).ELTOQUE_API_URL || "https://eltoque.com/api/v1/tasas";
}

// Parser defensivo: elToque ha cambiado el shape del JSON varias veces.
// Acepta { tasas: { USD: x } }, { rates: {...} } o claves sueltas.
function parseElToqueRates(data: any): Record<string, number> {
  const src = data?.tasas || data?.rates || data || {};
  const out: Record<string, number> = {};
  for (const cur of ["USD", "MLC", "EUR", "CLASICA"] as const) {
    const v = Number(src[cur]);
    if (isFinite(v) && v > 0) out[cur] = v; // CUP por 1 unidad de la moneda
  }
  return out;
}

export async function getExchangeRates(
  db: ReturnType<typeof drizzle>,
  env: Env,
  companyId: string,
): Promise<{ mode: string; rates: Record<string, number>; updatedAt: Date | null }> {
  const s = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId)).get();
  if (!s) return { mode: "manual", rates: {}, updatedAt: null };

  if (s.rateMode === "eltoque") {
    const age = s.elToqueUpdatedAt
      ? Date.now() - new Date(s.elToqueUpdatedAt as any).getTime()
      : Infinity;
    const cached = (s.elToqueRates as Record<string, number>) || {};
    if (age < ELTOQUE_TTL_MS && Object.keys(cached).length > 0) {
      return { mode: "eltoque", rates: cached, updatedAt: s.elToqueUpdatedAt as any };
    }

    // Refrescar (best-effort): si elToque falla, seguimos con lo cacheado
    // aunque esté vencido — mejor una tasa vieja que ventas bloqueadas.
    try {
      const res = await fetch(elToqueUrl(env), {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(8000),
      } as any);
      if (res.ok) {
        const data = await res.json();
        const rates = parseElToqueRates(data);
        if (Object.keys(rates).length > 0) {
          const now = new Date();
          await db.update(schema.companySettings)
            .set({ elToqueRates: rates, elToqueUpdatedAt: now, updatedAt: now })
            .where(eq(schema.companySettings.companyId, companyId));
          return { mode: "eltoque", rates, updatedAt: now };
        }
      }
    } catch {
      // silencio: usamos caché
    }
    return { mode: "eltoque", rates: cached, updatedAt: s.elToqueUpdatedAt as any };
  }

  return { mode: "manual", rates: (s.manualRates as Record<string, number>) || {}, updatedAt: null };
}

// ── GET /settings — cualquier usuario autenticado (el POS lo necesita) ──────
settings.get("/", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  let s = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, auth.companyId)).get();
  if (!s) {
    // Defaults: solo CUP, tasa manual.
    s = await db.insert(schema.companySettings).values({ companyId: auth.companyId }).returning().get();
  }
  const ratesInfo = await getExchangeRates(db, c.env, auth.companyId);
  return c.json({
    ok: true,
    data: {
      currencies: s.currencies,
      rateMode: s.rateMode,
      manualRates: s.manualRates,
      rates: ratesInfo.rates,
      ratesUpdatedAt: ratesInfo.updatedAt,
    },
  });
});

// ── PUT /settings — solo admin ──────────────────────────────────────────────
settings.put("/", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{
    currencies?: string[];
    rateMode?: "manual" | "eltoque";
    manualRates?: Record<string, number>;
  }>();

  let s = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, auth.companyId)).get();
  if (!s) {
    s = await db.insert(schema.companySettings).values({ companyId: auth.companyId }).returning().get();
  }

  const updates: Partial<typeof schema.companySettings.$inferInsert> = { updatedAt: new Date() };

  if (body.currencies !== undefined) {
    const list = Array.isArray(body.currencies) ? body.currencies : [];
    const valid = list.filter((m) => (SUPPORTED_CURRENCIES as readonly string[]).includes(m));
    if (valid.length === 0) {
      return c.json({ ok: false, error: "Debe seleccionar al menos una moneda" }, 400);
    }
    if (!valid.includes("CUP")) {
      return c.json({ ok: false, error: "CUP es obligatoria como moneda base" }, 400);
    }
    updates.currencies = valid;
  }

  if (body.rateMode !== undefined) {
    if (!["manual", "eltoque"].includes(body.rateMode)) {
      return c.json({ ok: false, error: "rateMode inválido" }, 400);
    }
    updates.rateMode = body.rateMode;
  }

  if (body.manualRates !== undefined) {
    const mr: Record<string, number> = {};
    for (const [k, v] of Object.entries(body.manualRates || {})) {
      if (!(SUPPORTED_CURRENCIES as readonly string[]).includes(k)) {
        return c.json({ ok: false, error: `Moneda inválida en manualRates: ${k}` }, 400);
      }
      const n = Number(v);
      if (!isFinite(n) || n < 0) return c.json({ ok: false, error: `Tasa inválida para ${k}` }, 400);
      if (n > 0) mr[k] = n;
    }
    updates.manualRates = mr;
  }

  await db.update(schema.companySettings).set(updates)
    .where(eq(schema.companySettings.companyId, auth.companyId));

  await logAudit(c.env, {
    companyId: auth.companyId,
    userId: auth.userId,
    action: "settings.update",
    entity: "company_settings",
    entityId: auth.companyId,
    detail: updates as any,
    ip: getClientIp(c),
  });

  const updated = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, auth.companyId)).get();
  return c.json({ ok: true, data: updated });
});

export default settings;
