import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireRole, requireAnyModule } from "../middleware/roles";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";

// Las reglas puras (validación y cálculo) viven en lib/discountRules para que
// las ventas online y la sincronización offline usen el mismo código. Se
// reexportan aquí porque ya son parte del contrato de este módulo.
export { isDiscountAvailable, computeDiscountAmount, type DiscountRow } from "../lib/discountRules";

const discounts = new Hono<{ Bindings: Env }>();

discounts.use("*", authMiddleware);

// ── Validación de disponibilidad y cálculo ───────────────────────────────────
// (implementados en lib/discountRules y reexportados arriba)

// ── Listado ──────────────────────────────────────────────────────────────────
// Lo leen el POS y la facturación (para aplicar un descuento al vender), no el
// contador: por eso el módulo no es de libre acceso.
discounts.get("/", requireAnyModule("pos", "facturacion", "inventario"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const rows = await db.select().from(schema.discounts)
    .where(eq(schema.discounts.companyId, auth.companyId))
    .orderBy(desc(schema.discounts.createdAt)).all();
  return c.json({ ok: true, data: rows });
});

// ── Crear (solo admin) ───────────────────────────────────────────────────────
discounts.post("/", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{
    name: string; code?: string; scope: "producto" | "venta";
    type: "porcentaje" | "fijo"; value: number;
    maxUses?: number | null; locationScope: "todas" | "seleccion";
    locationIds?: string[]; startsAt?: string; endsAt?: string;
  }>();

  const { name, scope, type, value } = body;
  if (!name || !scope || !type || value === undefined) {
    return c.json({ ok: false, error: "name, scope, type y value son requeridos" }, 400);
  }
  if (!["producto", "venta"].includes(scope)) return c.json({ ok: false, error: "scope inválido" }, 400);
  if (!["porcentaje", "fijo"].includes(type)) return c.json({ ok: false, error: "type inválido" }, 400);
  const val = Number(value);
  if (!isFinite(val) || val <= 0) return c.json({ ok: false, error: "value debe ser > 0" }, 400);
  if (type === "porcentaje" && val > 100) return c.json({ ok: false, error: "El porcentaje no puede ser > 100" }, 400);
  if (body.locationScope === "seleccion" && (!Array.isArray(body.locationIds) || body.locationIds.length === 0)) {
    return c.json({ ok: false, error: "locationIds es requerido cuando locationScope=seleccion" }, 400);
  }

  const row = await db.insert(schema.discounts).values({
    id: generateUUID(),
    companyId: auth.companyId,
    name: body.name.trim(),
    code: body.code?.trim() || null,
    scope, type,
    value: val,
    maxUses: body.maxUses ?? null,
    locationScope: body.locationScope || "todas",
    locationIds: body.locationIds || [],
    startsAt: body.startsAt ? new Date(body.startsAt) : null,
    endsAt: body.endsAt ? new Date(body.endsAt) : null,
    active: true,
    createdBy: auth.userId,
  }).returning().get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "discount.create", entity: "discount", entityId: row.id,
    detail: { name: body.name, scope, type, value: val, locationScope: body.locationScope || "todas" },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: row }, 201);
});

// ── Actualizar (solo admin) — activar/desactivar o ajustar parámetros ───────
discounts.put("/:id", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const existing = await db.select().from(schema.discounts)
    .where(and(eq(schema.discounts.id, id), eq(schema.discounts.companyId, auth.companyId))).get();
  if (!existing) return c.json({ ok: false, error: "Descuento no encontrado" }, 404);

  const body = await c.req.json<{
    name?: string; code?: string | null; type?: "porcentaje" | "fijo";
    value?: number; maxUses?: number | null;
    locationScope?: "todas" | "seleccion"; locationIds?: string[];
    startsAt?: string | null; endsAt?: string | null; active?: boolean;
  }>();

  const updates: Partial<typeof schema.discounts.$inferInsert> = {};
  if (body.name !== undefined) updates.name = body.name.trim();
  if (body.code !== undefined) updates.code = body.code?.trim() || null;
  if (body.type !== undefined) {
    if (!"porcentaje fijo".split(" ").includes(body.type)) {
      return c.json({ ok: false, error: "type inválido" }, 400);
    }
    updates.type = body.type;
  }
  if (body.value !== undefined) {
    const val = Number(body.value);
    if (!isFinite(val) || val <= 0) return c.json({ ok: false, error: "value debe ser > 0" }, 400);
    if ((body.type || existing.type) === "porcentaje" && val > 100) {
      return c.json({ ok: false, error: "El porcentaje no puede ser > 100" }, 400);
    }
    updates.value = val;
  }
  if (body.maxUses !== undefined) updates.maxUses = body.maxUses;
  if (body.locationScope !== undefined) {
    if (!["todas", "seleccion"].includes(body.locationScope)) return c.json({ ok: false, error: "locationScope inválido" }, 400);
    if (body.locationScope === "seleccion" && (!Array.isArray(body.locationIds) || body.locationIds.length === 0)) {
      return c.json({ ok: false, error: "locationIds es requerido cuando locationScope=seleccion" }, 400);
    }
    updates.locationScope = body.locationScope;
    if (body.locationIds !== undefined) updates.locationIds = body.locationIds;
  } else if (body.locationIds !== undefined) {
    updates.locationIds = body.locationIds;
  }
  if (body.startsAt !== undefined) updates.startsAt = body.startsAt ? new Date(body.startsAt) : null;
  if (body.endsAt !== undefined) updates.endsAt = body.endsAt ? new Date(body.endsAt) : null;
  if (body.active !== undefined) updates.active = !!body.active;

  await db.update(schema.discounts).set(updates).where(eq(schema.discounts.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "discount.update", entity: "discount", entityId: id,
    detail: { before: { name: existing.name, active: existing.active }, changes: updates },
    ip: getClientIp(c),
  });

  const updated = await db.select().from(schema.discounts).where(eq(schema.discounts.id, id)).get();
  return c.json({ ok: true, data: updated });
});

// ── Eliminar (solo admin) ────────────────────────────────────────────────────
discounts.delete("/:id", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const existing = await db.select().from(schema.discounts)
    .where(and(eq(schema.discounts.id, id), eq(schema.discounts.companyId, auth.companyId))).get();
  if (!existing) return c.json({ ok: false, error: "Descuento no encontrado" }, 404);

  await db.delete(schema.discounts).where(eq(schema.discounts.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "discount.delete", entity: "discount", entityId: id,
    detail: { name: existing.name },
    ip: getClientIp(c),
  });

  return c.json({ ok: true });
});

export default discounts;
