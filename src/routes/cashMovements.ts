import { Hono } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireAnyModule, requireRole } from "../middleware/roles";
import { logAudit, getClientIp } from "../lib/audit";
import { generateUUID } from "../lib/jwt";
import { getActiveCompanyLocation, getOpenShiftForUser, getCajasAsignadas } from "../lib/locations";
import { notify, adminsOf } from "../lib/push";

// ─── ENTRADAS Y SALIDAS DE DINERO ────────────────────────────────────────────
//
// El problema que resuelve: cuando alguien saca plata de la caja, el cierre la
// ve como faltante y avisa de un robo que no ocurrió. No hay forma de
// distinguir "me faltó" de "el dueño retiró y no lo dijo".
//
// La regla acordada:
//  - un CAJERO solo puede registrar una salida con su turno abierto. Sin turno
//    no hay caja de la que sacado el dinero, así que no tiene sentido;
//  - un ADMIN puede siempre, porque es quien autoriza los retiros;
//  - todas requieren aprobación de un admin o un contador, si el negocio lo
//    tiene configurado así.

const cashMovements = new Hono<{ Bindings: Env }>();

cashMovements.use("*", authMiddleware);

async function puedeOperarEn(db: any, auth: any, locationId: string) {
  const loc = await getActiveCompanyLocation(db, auth.companyId, locationId);
  if (!loc) return { ok: false as const, error: "Esa caja no existe" };
  if (auth.role === "admin" || auth.role === "contador") return { ok: true as const, location: loc };
  if (auth.role === "cajero") {
    const turno = await getOpenShiftForUser(db, auth.companyId, auth.userId);
    if (turno && turno.locationId === loc.id) return { ok: true as const, location: loc, shift: turno };
    // También puede operar en una caja que tiene asignada, aunque ahora esté
    // trabajando en otra: la registra y ya se vera en el cierre de esa caja.
    const asignadas = await getCajasAsignadas(db, auth.companyId, auth.userId);
    if (asignadas.some((a) => a.id === loc.id)) return { ok: true as const, location: loc, shift: null };
    return { ok: false as const, error: "No tienes esa caja asignada" };
  }
  return { ok: false as const, error: "No tienes permisos para mover dinero" };
}

// GET /cash-movements?locationId=... — historial de la caja.
cashMovements.get("/", requireAnyModule("cierre", "pos", "contabilidad"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { locationId, pendientes } = c.req.query();

  const filas = await db.select({
    m: schema.cashMovements,
    userName: schema.users.name,
    approverName: schema.users.name,
    caja: schema.inventoryLocations.name,
  })
    .from(schema.cashMovements)
    .innerJoin(schema.users, eq(schema.cashMovements.userId, schema.users.id))
    .innerJoin(schema.inventoryLocations, eq(schema.cashMovements.locationId, schema.inventoryLocations.id))
    .where(eq(schema.cashMovements.companyId, auth.companyId))
    .orderBy(desc(schema.cashMovements.createdAt))
    .limit(200).all();

  const soloPendientes = pendientes === "1";
  const datos = filas
    .filter((f) => !locationId || f.m.locationId === locationId)
    .filter((f) => !soloPendientes || f.m.status === "pendiente")
    .map((f) => ({
      id: f.m.id,
      locationId: f.m.locationId,
      locationName: f.caja,
      type: f.m.type,
      amount: Number(f.m.amount),
      currency: f.m.currency,
      reason: f.m.reason,
      status: f.m.status,
      userName: f.userName,
      approvedAt: f.m.approvedAt,
      decisionNote: f.m.decisionNote,
      createdAt: f.m.createdAt,
    }));

  return c.json({ ok: true, data: datos });
});

// POST /cash-movements — registrar una entrada o salida.
cashMovements.post("/", requireAnyModule("cierre", "pos", "contabilidad"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ locationId?: string; type?: string; amount?: number; currency?: string; reason?: string; businessAt?: string | number }>().catch(() => null);
  if (!body?.locationId) return c.json({ ok: false, error: "Indica la caja" }, 400);

  const type = body.type === "entrada" ? "entrada" : "salida";
  const amount = Number(body.amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    return c.json({ ok: false, error: "La cantidad tiene que ser mayor que cero" }, 400);
  }
  if (amount > 1e9) return c.json({ ok: false, error: "Esa cantidad es demasiado grande" }, 400);

  const currency = (body.currency || "CUP").toUpperCase().slice(0, 8);
  const motivo = (body.reason || "").trim();

  // Una salida sin motivo es exactamente el caso que esta pantalla viene a
  // arreglar: un retiro sin explicación es indistinguible de un robo.
  if (type === "salida" && !motivo) {
    return c.json({ ok: false, error: "Escribe para qué es la salida. Sin motivo no se puede registrar." }, 400);
  }

  const perm = await puedeOperarEn(db, auth, body.locationId);
  if (!perm.ok) return c.json({ ok: false, error: perm.error }, 403);

  // Un cajero sin turno abierto no registra salidas: sin turno no hay caja de
  // la que saiu el dinero, y después nadie sabe a qué turno atribuirlo.
  if (type === "salida" && auth.role === "cajero") {
    const turno = await getOpenShiftForUser(db, auth.companyId, auth.userId);
    if (!turno) {
      return c.json({ ok: false, error: "Abre tu turno antes de registrar una salida de dinero." }, 403);
    }
  }

  // ¿El negocio exige aprobación?
  const settings: any = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, auth.companyId)).get();
  const requiereAprobacion = settings?.cashRequireApproval !== false;
  // Quien aprueba no puede ser quien registra: si un admin pudiera aprobar su
  // propio retiro, el control no controlaría nada.
  const puedeAutoAprobar = !requiereAprobacion || auth.role === "admin";

  // Hora de negocio: cuándo SAHIO (o entró) el dinero de verdad. Es lo que hace
  // que la conciliación de la apertura siguiente cuente el retiro en su periodo y
  // no en el día que volvió la conexión. Si no viene, se usa ahora.
  const negocioEn = (() => {
    const b = body?.businessAt;
    if (b === undefined || b === null || b === "") return new Date();
    const d = new Date(typeof b === "number" ? b : String(b));
    return Number.isFinite(d.getTime()) ? d : new Date();
  })();

  const turno = await getOpenShiftForUser(db, auth.companyId, auth.userId);
  const id = generateUUID();
  const mov = await db.insert(schema.cashMovements).values({
    id, companyId: auth.companyId, locationId: body.locationId,
    shiftId: turno?.locationId === body.locationId ? turno.id : null,
    userId: auth.userId, type, amount, currency,
    businessAt: negocioEn,
    reason: motivo || null,
    status: puedeAutoAprobar ? "aprobada" : "pendiente",
    approvedById: puedeAutoAprobar ? auth.userId : null,
    approvedAt: puedeAutoAprobar ? new Date() : null,
  }).returning().get();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "cash_movement.create", entity: "cash_movement", entityId: id,
    detail: { type, amount, currency, motivo, status: mov.status }, ip: getClientIp(c),
  });

  // Si queda pendiente, quien tiene que aprobarlo se entera.
  if (!puedeAutoAprobar) {
    const paraAdmins = await adminsOf(db, auth.companyId);
    const accountant = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(eq(schema.users.companyId, auth.companyId), eq(schema.users.role, "contador"))).all();
    const quien = await db.select({ name: schema.users.name }).from(schema.users)
      .where(eq(schema.users.id, auth.userId)).get();
    const targets: string[] = [...paraAdmins, ...accountant.map((a) => String(a.id))];
    if (targets.length) {
      void notify({
        env: c.env, db, companyId: auth.companyId, userIds: [...new Set(targets)],
        type: "cash_movement.pending",
        title: type === "salida" ? "Salida de dinero por aprobar" : "Entrada de dinero por aprobar",
        body: `${quien?.name || "Alguien"} registró ${amount} ${currency} ${type === "salida" ? "que salen de" : "que entran a"} ${perm.location.name}.`,
        link: "/cierre",
        data: { movementId: id, kind: "cash_movement.pending" },
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      });
    }
  }

  return c.json({ ok: true, data: mov }, 201);
});

// POST /cash-movements/:id/decide — aprobar o rechazar.
cashMovements.post("/:id/decide", requireAnyModule("cierre", "contabilidad"), requireRole("admin", "contador"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = await c.req.json<{ decision?: string; note?: string }>().catch(() => null);
  const decision = body?.decision === "aprobar" ? "aprobada" : body?.decision === "rechazar" ? "rechazada" : null;
  if (!decision) return c.json({ ok: false, error: "Indica si apruebas o rechazas" }, 400);

  const mov = await db.select().from(schema.cashMovements)
    .where(and(eq(schema.cashMovements.id, id), eq(schema.cashMovements.companyId, auth.companyId))).get();
  if (!mov) return c.json({ ok: false, error: "Movimiento no encontrado" }, 404);
  if (mov.status !== "pendiente") {
    return c.json({ ok: false, error: "Ese movimiento ya se decidió antes" }, 409);
  }
  if (mov.userId === auth.userId && decision === "aprobada") {
    return c.json({ ok: false, error: "No puedes aprobar un movimiento que registraste tú mismo" }, 403);
  }

  await db.update(schema.cashMovements)
    .set({ status: decision, approvedById: auth.userId, approvedAt: new Date(), decisionNote: (body?.note || "").trim() || null })
    .where(eq(schema.cashMovements.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: `cash_movement.${decision}`, entity: "cash_movement", entityId: id,
    detail: { amount: mov.amount, currency: mov.currency }, ip: getClientIp(c),
  });

  // Quien lo registró se entera del veredicto: si le rechazan el retiro, tiene
  // que saberlo al momento, no descubrirlo en el cierre de la noche.
  void notify({
    env: c.env, db, companyId: auth.companyId, userIds: [mov.userId],
    type: `cash_movement.${decision}`,
    title: decision === "aprobada" ? "Salida aprobada" : "Salida rechazada",
    body: decision === "aprobada"
      ? `Se aprobó tu movimiento de ${mov.amount} ${mov.currency}.`
      : `Se rechazó tu movimiento de ${mov.amount} ${mov.currency}.${body?.note ? " Motivo: " + body.note : ""}`,
    link: "/cierre",
    data: { movementId: id, kind: `cash_movement.${decision}` },
    waitUntil: (p) => c.executionCtx.waitUntil(p),
  });

  return c.json({ ok: true, data: { id, status: decision } });
});

export default cashMovements;
