// ─── Avisos del navegador (PWA push) ────────────────────────────────────────
//
// Dos cosas distintas y a propósito:
//
// 1) `notifications` — el aviso GUARDADO en la app. Es la fuente de verdad.
// 2) `push` — el empujón al navegador. Puede fallar (móvil sin batería, la
//    persona cerró la app a la fuerza, un iPhone sin "añadir a pantalla de
//    inicio"). Por eso nada depende de que el push llegue.
//
// El orden importa: primero se guarda, después se empuja. Si el push revienta,
// el aviso sigue ahí. Al revés, se perderían avisos.
//
// Se manda con `ctx.waitUntil()` desde las rutas para que la respuesta al
// usuario no espere a los servidores de Mozilla/Google: el cliente no tiene por
// qué pagar la latencia de un aviso.

// No se importa `web-push` en el nivel superior a propósito: si el paquete no
// estuviera instalado, TODO el Worker dejaría de cargar (incluido el login).
// Se carga bajo demanda dentro de una función, y un backend sin el paquete
// simplemente no manda push, pero el resto sigue funcionando.
import { and, eq } from "drizzle-orm";
import * as schema from "../db/schema";

type WebPushModule = {
  setVapidDetails: (subject: string, publicKey: string, privateKey: string) => void;
  sendNotification: (sub: unknown, payload?: string | null, options?: unknown) => Promise<unknown>;
};

let webPushPromise: Promise<WebPushModule> | null = null;
let vapidReady = false;

async function getWebPush(env: Env): Promise<WebPushModule | null> {
  const subject = env.VAPID_SUBJECT || "mailto:kirox850@gmail.com";
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) {
    // Una vez por ejecución, no una por aviso.
    if (!vapidReady) {
      console.error("push: faltan VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY — no se mandarán avisos");
      vapidReady = true;
    }
    return null;
  }
  try {
    if (!webPushPromise) {
      // Se copian a constantes: la comprobación de "faltan" está más arriba y
      // TypeScript la pierde dentro del closure, aunque en runtime siga siendo
      // cierta. Copiar además evita que un cambio a mitad de vuelo los cambie.
      const publicKey = env.VAPID_PUBLIC_KEY;
      const privateKey = env.VAPID_PRIVATE_KEY;
      webPushPromise = import("web-push").then((m) => {
        const wp = ((m as any).default ?? m) as WebPushModule;
        wp.setVapidDetails(subject, publicKey, privateKey);
        return wp;
      });
    }
    return await webPushPromise;
  } catch {
    console.error("push: falta la librería 'web-push' (npm i web-push) — no se mandarán avisos");
    return null;
  }
}

type NotifyInput = {
  env: Env;
  db: ReturnType<typeof import("drizzle-orm/d1").drizzle<typeof import("../db/schema")>>;
  companyId: string;
  /** A quién va. Sin esto: a todos los usuarios activos de la empresa. */
  userIds?: string[];
  type: string;
  title: string;
  body: string;
  /** Pantalla a la que lleva al hacer clic. */
  link?: string;
  data?: Record<string, unknown>;
  /** Para que la respuesta no espere al envío. */
  waitUntil?: (p: Promise<unknown>) => void;
};

/**
 * Guarda el aviso y lo empuja al navegador. Nunca lanza: un fallo de aviso no
 * puede tumbar la venta o la aprobación de un envío que ya se está haciendo.
 */
export async function notify(input: NotifyInput): Promise<void> {
  const { env, db, companyId, type, title, body, link, data, userIds } = input;
  try {
    const id = crypto.randomUUID();
    await db.insert(schema.notifications).values({
      id,
      companyId,
      userId: userIds && userIds.length === 1 ? userIds[0] : null,
      type,
      title,
      body,
      link: link ?? null,
      data: data ? JSON.stringify(data) : null,
    });

    const run = pushToBrowsers(env, db, { id, companyId, userIds, title, body, link, data });
    if (input.waitUntil) input.waitUntil(run);
    else await run;
  } catch (err) {
    console.error(`push: no se pudo registrar el aviso "${type}":`, errorMessage(err));
  }
}

async function pushToBrowsers(
  env: Env,
  db: NotifyInput["db"],
  msg: { id: string; companyId: string; userIds?: string[]; title: string; body: string; link?: string; data?: Record<string, unknown> }
) {
  const wp = await getWebPush(env);
  if (!wp) return;

  const subs = await db.select().from(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.companyId, msg.companyId)).all();
  if (subs.length === 0) return;

  // A quién le toca este aviso: si viene una lista de personas, solo a ellas.
  const targets = msg.userIds?.length ? subs.filter((s) => msg.userIds!.includes(s.userId ?? "")) : subs;
  if (targets.length === 0) return;

  const payload = JSON.stringify({
    id: msg.id,
    title: msg.title,
    body: msg.body,
    link: msg.link,
    data: msg.data,
  });

  await Promise.all(
    targets.map(async (sub) => {
      try {
        await wp.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          payload,
          { TTL: 60 * 60 * 12, urgency: "high" },
        );
        await db.update(schema.pushSubscriptions)
          .set({ lastOkAt: new Date(), failures: 0 })
          .where(eq(schema.pushSubscriptions.id, sub.id));
      } catch (err: any) {
        const status = err?.statusCode;
        // 404/410 = ese navegador ya no existe (se desinstaló, se borró el
        // permiso). No tiene sentido reintentar jamás: se borra la fila.
        if (status === 404 || status === 410) {
          await db.delete(schema.pushSubscriptions).where(eq(schema.pushSubscriptions.id, sub.id));
          return;
        }
        // Cualquier otro fallo (servicio caído, sin red) es del servicio, no
        // del navegador: se anota y se deja la suscripción viva para reintentar.
        await db.update(schema.pushSubscriptions)
          .set({ failures: sub.failures + 1 })
          .where(eq(schema.pushSubscriptions.id, sub.id));
        console.error(`push: fallo al avisar (${status ?? "sin código"}), se reintentará:`, errorMessage(err));
      }
    })
  );
}

// ── Quién recibe cada aviso ────────────────────────────────────────────────
// Los envíos de stock son ENTRE UBICACIONES DE LA MISMA EMPRESA (no entre
// empresas): quien recibe es el usuario que está en la ubicación de destino.
// Las reglas son las mismas de `canResolveTransfer` en routes/transfers.ts:
//   destino = almacén → todos los almacenistas activos
//   destino = caja   → el cajero dueño de esa caja
// Si no hay nadie (una caja sin dueño, un almacén vacío), se avisa a los admins:
// no pueden aprobar —eso da 403 por diseño— pero sí pueden reasignar o enterarse.

export async function transferRecipients(
  db: NotifyInput["db"],
  companyId: string,
  toLocationId: string
): Promise<string[]> {
  const loc = await db.select().from(schema.inventoryLocations)
    .where(and(eq(schema.inventoryLocations.id, toLocationId), eq(schema.inventoryLocations.companyId, companyId)))
    .get();
  if (!loc) return [];

  if (loc.type === "caja") {
    if (!loc.ownerUserId) return [];
    const owner = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(eq(schema.users.id, loc.ownerUserId), eq(schema.users.active, true))).get();
    return owner ? [owner.id] : [];
  }

  if (loc.type === "almacen") {
    const rows = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(
        eq(schema.users.companyId, companyId),
        eq(schema.users.role, "almacenista"),
        eq(schema.users.active, true),
      )).all();
    return rows.map((r) => r.id);
  }

  return [];
}

/** Si no hay a quién avisar, los admins: alguien tiene que enterarse. */
export async function adminsOf(db: NotifyInput["db"], companyId: string): Promise<string[]> {
  const rows = await db.select({ id: schema.users.id }).from(schema.users)
    .where(and(eq(schema.users.companyId, companyId), eq(schema.users.role, "admin"), eq(schema.users.active, true)))
    .all();
  return rows.map((r) => r.id);
}

/** A los admins, o a los destinatarios si existen. Para no avisar al doble. */
export async function transferRecipientsOrAdmins(
  db: NotifyInput["db"],
  companyId: string,
  toLocationId: string
): Promise<string[]> {
  const recips = await transferRecipients(db, companyId, toLocationId);
  return recips.length > 0 ? recips : await adminsOf(db, companyId);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
