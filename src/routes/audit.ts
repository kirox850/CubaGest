import { Hono } from "hono";
import { eq, and, desc, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";

const audit = new Hono<{ Bindings: Env }>();

audit.use("*", authMiddleware);

// GET /audit
// Solo admin: la vista completa incluye el detalle del evento y la IP desde la
// que se hizo. Antes la ruta no tenía control de permisos y cualquier usuario
// autenticado (cajero, almacenista, contador) veía el detalle completo de la
// operación de los demás. La vista REDACTADA para el contador (mismos eventos,
// sin detalle ni IP) queda para la fase siguiente; hasta entonces la ruta es
// exclusiva del admin, igual que en el web y el móvil.
audit.get("/", requireModule("auditoria"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { entity, action, userId, limit, offset } = c.req.query();
  const canSeeSensitive = auth.role === "admin";

  const conditions: ReturnType<typeof eq>[] = [eq(schema.auditLogs.companyId, auth.companyId)];
  if (entity) conditions.push(eq(schema.auditLogs.entity, entity));
  if (action) conditions.push(like(schema.auditLogs.action, `%${action}%`));
  if (userId) conditions.push(eq(schema.auditLogs.userId, userId));

  const take = Math.min(Number(limit) || 100, 500);
  const skip = Number(offset) || 0;

  const rows = await db.select().from(schema.auditLogs)
    .where(and(...conditions))
    .orderBy(desc(schema.auditLogs.createdAt))
    .limit(take).offset(skip).all();

  // Adjuntar nombre del usuario para no obligar al frontend a cruzarlo.
  const users = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)
    .where(eq(schema.users.companyId, auth.companyId)).all();
  const usersMap: Record<string, string> = {};
  for (const u of users) usersMap[u.id] = u.name;

  const result = rows.map((r) => {
    const parsed = (() => { try { return r.detail ? JSON.parse(r.detail) : null; } catch { return r.detail; } })();
    return {
      id: r.id,
      companyId: r.companyId,
      userId: r.userId,
      userName: r.userId ? (usersMap[r.userId] || "Usuario eliminado") : "Sistema",
      action: r.action,
      entity: r.entity,
      entityId: r.entityId,
      createdAt: r.createdAt,
      // Datos sensibles solo para admin.
      detail: canSeeSensitive ? parsed : null,
      ip: canSeeSensitive ? r.ip : null,
      redacted: !canSeeSensitive,
    };
  });

  return c.json({ ok: true, data: result, redacted: !canSeeSensitive });
});

export default audit;
