import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireRole } from "../middleware/roles";
import { checkLimit } from "../middleware/plans";
import { hashPassword } from "../lib/hash";
import { generateUUID } from "../lib/jwt";

const users = new Hono<{ Bindings: Env }>();

users.use("*", authMiddleware);

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

  const validRoles = ["admin", "cajero", "contador", "almacenista"];
  if (!validRoles.includes(role)) {
    return c.json({ ok: false, error: `Rol inválido. Use uno de: ${validRoles.join(", ")}` }, 400);
  }

  const existing = await db.select().from(schema.users).where(eq(schema.users.email, email)).get();
  if (existing) return c.json({ ok: false, error: "Ya existe un usuario con ese correo" }, 409);

  const passwordHash = await hashPassword(password);
  const user = await db.insert(schema.users).values({
    id: generateUUID(),
    companyId: auth.companyId,
    name, email, passwordHash, role, nit: nit || null,
  }).returning().get();

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
  if (body.role !== undefined) {
    const validRoles = ["admin", "cajero", "contador", "almacenista"];
    if (!validRoles.includes(body.role)) {
      return c.json({ ok: false, error: `Rol inválido. Use uno de: ${validRoles.join(", ")}` }, 400);
    }
    updates.role = body.role;
  }
  if (body.nit !== undefined) updates.nit = body.nit;
  if (body.active !== undefined) updates.active = body.active;
  if (body.password) updates.passwordHash = await hashPassword(body.password);

  await db.update(schema.users).set(updates).where(eq(schema.users.id, id));

  const updated = await db.select().from(schema.users).where(eq(schema.users.id, id)).get();
  const { passwordHash: _omit, ...safe } = updated!;
  return c.json({ ok: true, data: safe });
});

users.delete("/:id", requireModule("usuarios"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");

  if (id === auth.userId) return c.json({ ok: false, error: "No puede desactivarse a sí mismo" }, 400);

  const user = await db.select().from(schema.users)
    .where(and(eq(schema.users.id, id), eq(schema.users.companyId, auth.companyId))).get();
  if (!user) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);

  await db.update(schema.users).set({ active: false }).where(eq(schema.users.id, id));
  return c.json({ ok: true });
});

export default users;
