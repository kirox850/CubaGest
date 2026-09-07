import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireRole } from "../middleware/roles";
import { checkLimit } from "../middleware/plans";
import { hashPassword } from "../lib/hash";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { ensureCajaLocation, getCajaLocationForUser, returnAllStockToAlmacen } from "../lib/locations";

const users = new Hono<{ Bindings: Env }>();

users.use("*", authMiddleware);

const VALID_ROLES = ["admin", "cajero", "contador", "almacenista"];

users.get("/", requireModule("usuarios"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const rows = await db.select({
    id: schema.users.id,
    companyId: schema.users.companyId,
    name: schema.users.name,
    email: schema.users.email,
    role: schema.users.role,
    nit: schema.users.nit,
    active: schema.users.active,
    lastLoginAt: schema.users.lastLoginAt,
    createdAt: schema.users.createdAt,
  }).from(schema.users).where(eq(schema.users.companyId, auth.companyId)).orderBy(schema.users.createdAt);
  return c.json({ ok: true, data: rows });
});

users.post("/", requireModule("usuarios"), checkLimit("users"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ name: string; email: string; password: string; role: string; nit?: string }>();
  const { name, email, password, role, nit } = body;

  if (!name || !email || !password || !role) {
    return c.json({ ok: false, error: "Faltan campos requeridos" }, 400);
  }
  if (!VALID_ROLES.includes(role)) {
    return c.json({ ok: false, error: `Rol inválido. Use uno de: ${VALID_ROLES.join(", ")}` }, 400);
  }

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (existing) return c.json({ ok: false, error: "Ya existe un usuario con ese correo" }, 409);

  const passwordHash = await hashPassword(password);
  const user = await db.insert(schema.users).values({
    id: generateUUID(),
    companyId: auth.companyId,
    name, email, passwordHash, role: role as any, nit: nit || null,
  }).returning().get();

  // Un cajero nuevo tiene su propia caja/inventario desde el día uno, con
  // una lectura de apertura vacía para poder hacer cierre sin depender de
  // que un admin la tome manualmente primero.
  if (role === "cajero") {
    const location = await ensureCajaLocation(db, auth.companyId, user.id, user.name);
    await db.insert(schema.inventoryReadings).values({
      id: generateUUID(),
      companyId: auth.companyId,
      locationId: location.id,
      takenById: auth.userId,
      type: "apertura",
      notes: "Lectura inicial automática (caja nueva)",
      items: [],
    });
  }

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "user.create", entity: "user", entityId: user.id,
    detail: { name, email, role },
    ip: getClientIp(c),
  });

  const { passwordHash: _omit, ...safe } = user;
  return c.json({ ok: true, data: safe }, 201);
});

users.put("/:id", requireModule("usuarios"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const user = await db.select().from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.companyId, auth.companyId))).get();
  if (!user) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);

  const body = await c.req.json<{ name?: string; role?: string; nit?: string; active?: boolean; password?: string }>();
  const updates: Partial<typeof schema.users.$inferInsert> = {};

  if (body.name !== undefined) updates.name = body.name;
  const roleChanging = body.role !== undefined && body.role !== user.role;
  if (body.role !== undefined) {
    if (!VALID_ROLES.includes(body.role)) {
      return c.json({ ok: false, error: `Rol inválido. Use uno de: ${VALID_ROLES.join(", ")}` }, 400);
    }
    updates.role = body.role as any;
  }
  if (body.nit !== undefined) updates.nit = body.nit;
  if (body.active !== undefined) updates.active = body.active;
  if (body.password) updates.passwordHash = await hashPassword(body.password);

  // Si deja de ser cajero, su inventario vuelve al almacén automáticamente
  // — no se queda "flotando" sin dueño operativo.
  if (roleChanging && user.role === "cajero" && body.role !== "cajero") {
    const caja = await getCajaLocationForUser(db, auth.companyId, user.id);
    if (caja) {
      const { itemsReturned } = await returnAllStockToAlmacen(db, auth.companyId, caja.id, auth.userId, `Cambio de rol de ${user.name} (${user.role} → ${body.role})`);
      await db.update(schema.inventoryLocations).set({ active: false }).where(eq(schema.inventoryLocations.id, caja.id));
      if (itemsReturned > 0) {
        await logAudit(c.env, {
          companyId: auth.companyId, userId: auth.userId,
          action: "location.auto_return_stock", entity: "inventory_location", entityId: caja.id,
          detail: { reason: "role_change", user: user.name, itemsReturned },
          ip: getClientIp(c),
        });
      }
    }
  }
  // Si ahora SÍ es cajero (y antes no lo era), se le crea su caja.
  if (roleChanging && body.role === "cajero" && user.role !== "cajero") {
    const location = await ensureCajaLocation(db, auth.companyId, user.id, body.name || user.name);
    const hasReading = await db.select().from(schema.inventoryReadings)
      .where(eq(schema.inventoryReadings.locationId, location.id)).get();
    if (!hasReading) {
      await db.insert(schema.inventoryReadings).values({
        id: generateUUID(), companyId: auth.companyId, locationId: location.id, takenById: auth.userId,
        type: "apertura", notes: "Lectura inicial automática (caja nueva)", items: [],
      });
    }
  }
  // Si se reactiva un cajero que ya tenía caja (estaba inactiva), reactivarla.
  if (body.active === true && !user.active && (body.role || user.role) === "cajero") {
    await ensureCajaLocation(db, auth.companyId, user.id, body.name || user.name);
  }

  await db.update(schema.users).set(updates).where(eq(schema.users.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "user.update", entity: "user", entityId: id,
    detail: { before: { name: user.name, role: user.role, active: user.active }, changes: { ...updates, passwordHash: updates.passwordHash ? "(cambiada)" : undefined } },
    ip: getClientIp(c),
  });

  const updated = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  const { passwordHash: _omit, ...safe } = updated!;
  return c.json({ ok: true, data: safe });
});

// Solo admin puede dar de baja personal (ya lo garantiza requireModule
//("usuarios"), que hoy solo tiene el rol admin — esto lo deja explícito).
users.delete("/:id", requireModule("usuarios"), requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  if (id === auth.userId) return c.json({ ok: false, error: "No puede desactivarse a sí mismo" }, 400);

  const user = await db.select().from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.companyId, auth.companyId))).get();
  if (!user) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);

  // Si es cajero, todo su inventario se devuelve al almacén antes de
  // desactivarlo — nunca queda stock "huérfano" en una caja inactiva.
  if (user.role === "cajero") {
    const caja = await getCajaLocationForUser(db, auth.companyId, user.id);
    if (caja) {
      const { itemsReturned } = await returnAllStockToAlmacen(db, auth.companyId, caja.id, auth.userId, `Baja de ${user.name}`);
      await db.update(schema.inventoryLocations).set({ active: false }).where(eq(schema.inventoryLocations.id, caja.id));
      if (itemsReturned > 0) {
        await logAudit(c.env, {
          companyId: auth.companyId, userId: auth.userId,
          action: "location.auto_return_stock", entity: "inventory_location", entityId: caja.id,
          detail: { reason: "user_deactivated", user: user.name, itemsReturned },
          ip: getClientIp(c),
        });
      }
    }
  }

  await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "user.deactivate", entity: "user", entityId: id,
    detail: { name: user.name, email: user.email, role: user.role },
    ip: getClientIp(c),
  });

  return c.json({ ok: true });
});

export default users;
