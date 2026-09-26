import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireRole } from "../middleware/roles";
import { checkLimit } from "../middleware/plans";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { issuePasswordToken, PENDING_ACTIVATION } from "../lib/passwordTokens";

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
    passwordHash: schema.users.passwordHash,
  }).from(schema.users).where(eq(schema.users.companyId, auth.companyId)).orderBy(schema.users.createdAt);
  // pending = true significa que todavía no activó su cuenta (nunca eligió
  // contraseña). No exponemos passwordHash real, solo si es el marcador.
  const result = rows.map(({ passwordHash, ...u }) => ({ ...u, pending: passwordHash === PENDING_ACTIVATION }));
  return c.json({ ok: true, data: result });
});

users.post("/", requireModule("usuarios"), checkLimit("users"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ name: string; email: string; role: string; nit?: string }>();
  const { name, email, role, nit } = body;

  if (!name || !email || !role) {
    return c.json({ ok: false, error: "Faltan campos requeridos" }, 400);
  }
  if (!VALID_ROLES.includes(role)) {
    return c.json({ ok: false, error: `Rol inválido. Use uno de: ${VALID_ROLES.join(", ")}` }, 400);
  }

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (existing) return c.json({ ok: false, error: "Ya existe un usuario con ese correo" }, 409);

  // No se pide ni se guarda ninguna contraseña acá — el propio usuario la
  // elige a través del link que le llega por correo. Mientras tanto queda
  // con un marcador que nunca puede usarse para iniciar sesión.
  const user = await db.insert(schema.users).values({
    id: generateUUID(),
    companyId: auth.companyId,
    name, email, passwordHash: PENDING_ACTIVATION, role: role as any, nit: nit || null,
  }).returning().get();

  // Ya NO se le crea una caja propia. Las cajas son del negocio y las asigna
  // el admin (PUT /shift/assignments/:userId): así dos personas pueden
  // trabajar el mismo mostrador sin duplicar el inventario.

  const { url, emailSent } = await issuePasswordToken(c.env, db, user, "set_password");

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "user.create", entity: "user", entityId: user.id,
    detail: { name, email, role, emailSent },
    ip: getClientIp(c),
  });

  const { passwordHash: _omit, ...safe } = user;
  // setPasswordUrl viaja en la respuesta como respaldo — por si el correo no
  // llega (spam, correo mal escrito, etc.) admin puede compartir el link a
  // mano. No es un problema de seguridad porque solo lo ve admin, que ya
  // tiene acceso total a la empresa de todas formas.
  return c.json({ ok: true, data: { ...safe, setPasswordUrl: url, emailSent } }, 201);
});

users.put("/:id", requireModule("usuarios"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const user = await db.select().from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.companyId, auth.companyId))).get();
  if (!user) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);

  const body = await c.req.json<{ name?: string; role?: string; nit?: string; active?: boolean }>();
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
  // Ya no se acepta "password" acá — admin no puede escribir la contraseña
  // de nadie. Para ayudar a alguien a cambiarla, usa
  // POST /users/:id/resend-set-password, que manda un link nuevo.

  // Si deja de ser cajero, se le quitan las cajas ASIGNADAS — y solo eso.
  //
  // Antes, además, devolvía todo el stock de la caja al almacén y la
  // desactivaba. Con cajas compartidas eso era peligroso: la caja es del
  // negocio, y si tres cajeros trabajan el mismo mostrador, dar de baja a uno
  // vaciaba el inventario que estaban usando los otros dos. El stock de una
  // caja compartida no "pertenece" a nadie, así que no se toca: si queda
  // mercancía en cajas sin nadie asignado, es decisión del admin, no un efecto
  // secundario de dar de baja a un empleado.
  if (roleChanging && user.role === "cajero" && body.role !== "cajero") {
    await db.delete(schema.locationAssignments).where(and(
      eq(schema.locationAssignments.companyId, auth.companyId),
      eq(schema.locationAssignments.userId, user.id),
    ));
    await logAudit(c.env, {
      companyId: auth.companyId, userId: auth.userId,
      action: "location.assignments_cleared", entity: "user", entityId: user.id,
      detail: { reason: "role_change", user: user.name, from: user.role, to: body.role },
      ip: getClientIp(c),
    });
  }

  await db.update(schema.users).set(updates).where(eq(schema.users.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "user.update", entity: "user", entityId: id,
    detail: { before: { name: user.name, role: user.role, active: user.active }, changes: updates },
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

  // Mismo criterio que en el cambio de rol: se le quitan las cajas asignadas
  // y NO se toca el stock ni se desactiva ninguna caja. Con cajas compartidas,
  // vaciar "su" caja aquí Vaciaría la mercancía de los demás cajeros.
  if (user.role === "cajero") {
    await db.delete(schema.locationAssignments).where(and(
      eq(schema.locationAssignments.companyId, auth.companyId),
      eq(schema.locationAssignments.userId, user.id),
    ));
    await logAudit(c.env, {
      companyId: auth.companyId, userId: auth.userId,
      action: "location.assignments_cleared", entity: "user", entityId: user.id,
      detail: { reason: "user_deactivated", user: user.name },
      ip: getClientIp(c),
    });
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

// POST /users/:id/resend-set-password
// Regenera y reenvía el link de establecer contraseña — es lo que admin usa
// ahora en vez de escribirle una contraseña a alguien. Sirve tanto para una
// cuenta que nunca activó la suya, como para "ayudar" a alguien a resetear
// la suya sin que admin llegue a verla en ningún momento.
users.post("/:id/resend-set-password", requireModule("usuarios"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  const user = await db.select().from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.companyId, auth.companyId))).get();
  if (!user) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);

  const purpose = user.passwordHash === PENDING_ACTIVATION ? "set_password" : "forgot_password";
  const { url, emailSent } = await issuePasswordToken(c.env, db, user, purpose);

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "user.resend_password_link", entity: "user", entityId: id,
    detail: { name: user.name, email: user.email, emailSent },
    ip: getClientIp(c),
  });

  return c.json({ ok: true, data: { setPasswordUrl: url, emailSent } });
});

export default users;
