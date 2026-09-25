import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";

type DB = ReturnType<typeof drizzle>;

// ── CONFIGURACIÓN DE EMPRESA ─────────────────────────────────────────────────
// company_settings guarda qué monedas opera el negocio (mínimo CUP) y de dónde
// salen las tasas. Antes el registro de una empresa nueva NO creaba esta fila:
// la app caía a `|| ["CUP"]` en cada venta y el admin tenía que guardar los
// ajustes una vez para que existiera. Ahora se crea junto con la empresa.

/** Fila de company_settings; la crea si la empresa aún no tiene (idempotente). */
export async function ensureCompanySettings(db: DB, companyId: string) {
  const existing = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId)).get();
  if (existing) return existing;

  const created = await db.insert(schema.companySettings).values({
    companyId,
    currencies: ["CUP"],
    rateMode: "manual",
    manualRates: {},
    elToqueRates: {},
  }).returning().get();
  return created;
}

/**
 * Monedas que la empresa puede usar en ventas. Si la fila de settings no
 * existe (empresa muy antigua o creada a medias) se usa la moneda por defecto
 * de la empresa, y nunca una lista vacía: una venta con "" no sería válida.
 * Se normalizan a MAYÚSCULAS porque así las guarda la ruta de ajustes y es
 * como compara la venta; una fila vieja guardada en minúsculas ("cup") no puede
 * rechazar una venta legítima.
 */
export async function getAllowedCurrencies(
  db: DB,
  companyId: string,
  defaultCurrency: string
): Promise<string[]> {
  const s = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId)).get();
  const list = (s?.currencies as string[] | undefined) ?? [];
  if (Array.isArray(list)) {
    const normalized = list
      .filter((c): c is string => typeof c === "string")
      .map((c) => c.trim().toUpperCase())
      .filter(Boolean);
    if (normalized.length > 0) return Array.from(new Set(normalized));
  }
  return [(defaultCurrency || "CUP").toUpperCase()];
}
