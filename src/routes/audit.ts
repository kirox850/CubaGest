import { Hono } from "hono";
import { eq, and, desc, like } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireRole } from "../middleware/roles";

const audit = new Hono<{ Bindings: Env }>();

audit.use("*", authMiddleware);

// GET /audit — solo admin. Filtros opcionales: entity, action (coincidencia
// parcial), userId. Paginado simple con limit/offset.
audit.get("/", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { entity, action, userId, limit, offset } = c.req.query();

  const conditions: any[] = [eq(schema.auditLogs.companyId, auth.companyId)];
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
  const userIds = Array.from(new Set(rows.map(r => r.userId).filter(Boolean))) as string[];
  const usersMap: Record<string, string> = {};
  if (userIds.length > 0) {
    const users = await db.select({ id: schema.users.id, name: schema.users.name }).from(schema.users)
      .where(eq(schema.users.companyId, auth.companyId)).all();
    for (const u of users) usersMap[u.id] = u.name;
  }

  const result = rows.map(r => ({
    ...r,
    userName: r.userId ? (usersMap[r.userId] || "Usuario eliminado") : "Sistema",
    detail: (() => { try { return r.detail ? JSON.parse(r.detail) : null; } catch { return r.detail; } })(),
  }));

  return c.json({ ok: true, data: result });
});

export default audit;
