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

// ── Autenticación con elToque ──────────────────────────────────────────
// La API oficial (tasas.eltoque.com) requiere un TOKEN de autorización por
// aplicación. Se solicita en el formulario de https://tasas.eltoque.com/docs/
// y se configura en el Worker con:
//
//     npx wrangler secret put ELTOQUE_API_TOKEN
//
// El token viaja como "Authorization: Bearer <token>" y también como
// "x-api-key: <token>" (enviar ambos es inofensivo: la API usa el que
// corresponda). SIN token la API oficial responde 401/403 y el backend
// cae al raspado de la página pública (ver scrapeElToquePage).
function elToqueUrl(env: Env): string {
  return (env as any).ELTOQUE_API_URL || "https://tasas.eltoque.com/v1/current";
}

function elToqueHeaders(env: Env): Record<string, string> {
  const token = (env as any).ELTOQUE_API_TOKEN || (env as any).ELTOQUE_API_KEY;
  const h: Record<string, string> = {
    "Accept": "application/json",
    // Sin User-Agent algunos WAF (Cloudflare) rechazan la petición
    "User-Agent": "CubaGest/1.0",
  };
  if (token) {
    h["Authorization"] = `Bearer ${token}`;
    h["x-api-key"] = token;
  }
  return h;
}

// Los valores de elToque a veces llegan como "320.00 CUP x USD" o con coma
// decimal ("320,50") — parseFloat con limpieza se traga ambos formatos.
function toNum(v: any): number {
  if (typeof v === "number" && isFinite(v)) return v;
  const n = parseFloat(String(v ?? "").trim().replace(",", "."));
  return isFinite(n) ? n : NaN;
}

// Parser defensivo: elToque ha cambiado el shape del JSON varias veces.
// Acepta { tasas: { USD: x } }, { rates: {...} }, { data: { tasas } } o claves sueltas.
function parseElToqueRates(data: any): Record<string, number> {
  const src = data?.tasas || data?.rates || data?.data?.tasas || data || {};
  const out: Record<string, number> = {};
  for (const cur of ["USD", "MLC", "EUR", "CLASICA"] as const) {
    const v = toNum(src[cur]);
    if (v > 0) out[cur] = v; // CUP por 1 unidad de la moneda
  }
  return out;
}

// Fallback SIN token: raspado best-effort de la página pública donde elToque
// publica la tasa diaria. El HTML embebe las tasas como JSON (p.ej.
// "USD":"425.00 CUP x USD"). Es defensivo: si elToque cambia el HTML puede
// fallar — por eso la vía recomendada es el token oficial.
async function scrapeElToquePage(): Promise<Record<string, number>> {
  const res = await fetch("https://eltoque.com/tasa-de-cambio-today", {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml",
    },
    signal: AbortSignal.timeout(10000),
  } as any);
  if (!res.ok) return {};
  const html = await res.text();
  const out: Record<string, number> = {};
  for (const cur of ["USD", "EUR", "MLC"] as const) {
    // Captura el primer número que sigue a la etiqueta de la moneda,
    // tanto en "USD":320.5 como en "USD":"425.00 CUP x USD".
    const m = html.match(new RegExp(`"${cur}"\\s*:\\s*"?([0-9]+(?:[.,][0-9]+)?)`));
    if (m) {
      const v = toNum(m[1]);
      if (v > 0) out[cur] = v;
    }
  }
  return out;
}

export async function getExchangeRates(
  db: ReturnType<typeof drizzle>,
  env: Env,
  companyId: string,
  force = false,
): Promise<{ mode: string; rates: Record<string, number>; updatedAt: Date | null }> {
  const s = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId)).get();
  if (!s) return { mode: "manual", rates: {}, updatedAt: null };

  if (s.rateMode === "eltoque") {
    const age = s.elToqueUpdatedAt
      ? Date.now() - new Date(s.elToqueUpdatedAt as any).getTime()
      : Infinity;
    const cached = (s.elToqueRates as Record<string, number>) || {};
    if (!force && age < ELTOQUE_TTL_MS && Object.keys(cached).length > 0) {
      return { mode: "eltoque", rates: cached, updatedAt: s.elToqueUpdatedAt as any };
    }

    // Refrescar (best-effort): 1º API oficial (con token si está configurado);
    // 2º raspado de la página pública. Si ambas fallan, seguimos con lo
    // cacheado aunque esté vencido — mejor una tasa vieja que ventas bloqueadas.
    let rates: Record<string, number> = {};
    try {
      const res = await fetch(elToqueUrl(env), {
        headers: elToqueHeaders(env),
        signal: AbortSignal.timeout(8000),
      } as any);
      if (res.ok) {
        rates = parseElToqueRates(await res.json());
      } else {
        // Visible en Cloudflare → Workers → cubagest-backend → Logs
        console.warn(
          `[elToque] API respondió ${res.status} ${res.statusText}` +
          ((res.status === 401 || res.status === 403)
            ? " — falta o es inválido ELTOQUE_API_TOKEN (solicítalo en https://tasas.eltoque.com/docs/ y configura: npx wrangler secret put ELTOQUE_API_TOKEN)"
            : "")
        );
      }
    } catch (e: any) {
      console.warn("[elToque] API inaccesible:", e?.message || e);
    }
    if (Object.keys(rates).length === 0) {
      try { rates = await scrapeElToquePage(); } catch { /* seguimos con caché */ }
    }
    if (Object.keys(rates).length > 0) {
      const now = new Date();
      await db.update(schema.companySettings)
        .set({ elToqueRates: rates, elToqueUpdatedAt: now, updatedAt: now })
        .where(eq(schema.companySettings.companyId, companyId));
      return { mode: "eltoque", rates, updatedAt: now };
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
  // ?refresh=1 fuerza una consulta fresca a elToque (botón "Probar ahora"
  // del panel de Monedas) en vez de servir la caché de 5 minutos.
  const forceRefresh = c.req.query("refresh") === "1";
  const ratesInfo = await getExchangeRates(db, c.env, auth.companyId, forceRefresh);
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
