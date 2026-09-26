import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import { and, eq, desc, isNull, or, sql, inArray } from "drizzle-orm";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { errorMessage } from "../lib/batch";

const push = new Hono<{ Bindings: Env }>();
push.use("*", authMiddleware);

// La llave pública no es un secreto: viaja al navegador para poder suscribirse.
// Sin este GET la app no puede pedir permiso ni crear la suscripción.
push.get("/public-key", (c) => {
  if (!c.env.VAPID_PUBLIC_KEY) {
    return c.json({ ok: false, error: "Los avisos no están configurados en este servidor" }, 503);
  }
  return c.json({ ok: true, data: { publicKey: c.env.VAPID_PUBLIC_KEY } });
});

// Suscribir este navegador. Idempotente por endpoint: si el mismo navegador se
// suscribe dos veces (recargó la página, abrió el PWA en dos pestañas) se
// actualiza la fila, no se duplica. Y si ese navegador estaba en otra empresa,
// se reasigna a la actual: así quien entra con otra cuenta no deja avisos
// routed a la anterior.
push.post("/subscribe", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ endpoint?: string; keys?: { p256dh?: string; auth?: string } }>().catch(() => ({} as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }));

  const endpoint = body.endpoint;
  const p256dh = body.keys?.p256dh;
  const authKey = body.keys?.auth;
  if (!endpoint || !p256dh || !authKey) {
    return c.json({ ok: false, error: "Datos de suscripción incompletos" }, 400);
  }
  // Un endpoint es un string largo opaco de un navegador. Si alguien mandara
  // otra cosa (una URL de la propia API, un texto gigante) se le deniega.
  if (endpoint.length > 1000 || !endpoint.startsWith("https://")) {
    return c.json({ ok: false, error: "Endpoint de suscripción inválido" }, 400);
  }

  const existing = await db.select().from(schema.pushSubscriptions)
    .where(eq(schema.pushSubscriptions.endpoint, endpoint)).get();

  if (existing) {
    await db.update(schema.pushSubscriptions).set({
      companyId: auth.companyId,
      userId: auth.userId,
      p256dh,
      auth: authKey,
      failures: 0,
      lastOkAt: null,
    }).where(eq(schema.pushSubscriptions.id, existing.id));
  } else {
    await db.insert(schema.pushSubscriptions).values({
      id: crypto.randomUUID(),
      companyId: auth.companyId,
      userId: auth.userId,
      endpoint,
      p256dh,
      auth: authKey,
      userAgent: c.req.header("user-agent") ?? null,
    });
  }
  return c.json({ ok: true });
});

// Dar de baja este navegador (el botón "desactivar avisos", o el permiso
// revocado desde el navegador). Se ignora si no existía: no es un error.
push.post("/unsubscribe", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ endpoint?: string }>().catch(() => ({} as { endpoint?: string }));
  if (!body.endpoint) return c.json({ ok: false, error: "Falta endpoint" }, 400);
  await db.delete(schema.pushSubscriptions)
    .where(and(
      eq(schema.pushSubscriptions.endpoint, body.endpoint),
      eq(schema.pushSubscriptions.companyId, auth.companyId),
    ));
  return c.json({ ok: true });
});

// ── Los avisos guardados ────────────────────────────────────────────────────
// Un aviso con user_id NULL es para toda la empresa; uno con user_id es de esa
// persona. La consulta junta ambos casos: los de la empresa más los suyos.
//
// company_id está SIEMPRE en el filtro: es lo que impide que alguien de la
// empresa A lea los avisos de la B preguntando un id.
push.get("/notifications", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const limit = Math.min(100, Math.max(1, Number(new URL(c.req.url).searchParams.get("limit") || 30)));
  const unreadOnly = new URL(c.req.url).searchParams.get("unread") === "1";

  const mine = or(
    isNull(schema.notifications.userId),
    eq(schema.notifications.userId, auth.userId),
  )!;
  const rows = await db.select().from(schema.notifications)
    .where(and(eq(schema.notifications.companyId, auth.companyId), unreadOnly ? and(mine, isNull(schema.notifications.readAt)) : mine))
    .orderBy(desc(schema.notifications.createdAt))
    .limit(limit);

  const [{ n }] = await db.select({ n: sql<number>`count(*)` }).from(schema.notifications)
    .where(and(eq(schema.notifications.companyId, auth.companyId), mine, isNull(schema.notifications.readAt)));

  return c.json({
    ok: true,
    data: {
      unread: n ?? 0,
      items: rows.map((r) => ({
        id: r.id,
        type: r.type,
        title: r.title,
        body: r.body,
        link: r.link,
        data: r.data ? JSON.parse(r.data) : null,
        readAt: r.readAt,
        createdAt: r.createdAt,
      })),
    },
  });
});

// Marcar como leídos. Con `all` marca los de la persona; con `ids`, solo esos.
// El company_id sigue en el filtro para que "marcar todo" no toque avisos de
// otra empresa.
push.post("/notifications/read", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ ids?: string[]; all?: boolean }>().catch(() => ({} as { ids?: string[]; all?: boolean }));

  const mine = or(
    isNull(schema.notifications.userId),
    eq(schema.notifications.userId, auth.userId),
  )!;

  if (Array.isArray(body.ids) && body.ids.length > 0) {
    await db.update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(
        eq(schema.notifications.companyId, auth.companyId),
        mine,
        isNull(schema.notifications.readAt),
        inArray(schema.notifications.id, body.ids.slice(0, 200)),
      ));
  } else if (body.all) {
    await db.update(schema.notifications)
      .set({ readAt: new Date() })
      .where(and(eq(schema.notifications.companyId, auth.companyId), mine, isNull(schema.notifications.readAt)));
  }
  return c.json({ ok: true });
});

export default push;
