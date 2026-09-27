import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireAnyModule, requireRole } from "../middleware/roles";
import { logAudit, getClientIp } from "../lib/audit";
import { generateUUID } from "../lib/jwt";
import {
  getCajasAsignadas, getOpenShiftForUser, getOpenShiftForLocation, getActiveCompanyLocation,
  turnosDisponiblesEn,
} from "../lib/locations";
import { dinero } from "../lib/cierreDinero";

// ─── TURNOS ──────────────────────────────────────────────────────────────────
//
// Un turno es "esta persona, en esta caja, desde esta hora". El cajero elige la
// caja de entre las que el admin le asignó, y al abrirlo queda registrada la
// lectura de apertura de ESA caja: ese es el punto de partida del conteo.
//
// Antes el cierre se ligaba a "la caja del cajero", y como la caja era suya y
// solo suya no había nada que elegir. Con cajas compartidas, dos personas
// pueden turnar sobre el mismo mostrador, y por eso hace falta saber quién
// tenía la caja y desde cuándo.

const shifts = new Hono<{ Bindings: Env }>();

shifts.use("*", authMiddleware);

// GET /shift/current — el turno abierto de quien pregunta, o null.
// Todo el cliente lo consulta al arrancar: de ahí sale la caja en la que está
// trabajando, sin tener que adivinarla.
shifts.get("/current", requireAnyModule("pos", "cierre", "inventario", "facturacion"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");

  // Si la migración de turnos no está aplicada, se dice con palabras claras en
  // vez de devolver un "no hay turno" que el móvil no distingue de "todavía no
  // abriste turno". Una de las dos cosas se arregla abriendo turno; la otra no
  // se arregla sola, y hay que decirlo.
  if (!(await turnosDisponiblesEn(db))) {
    return c.json({
      ok: true,
      data: {
        shift: null,
        assignedCajas: [],
        aviso: "La base de datos todavía no tiene las tablas de turnos. Hay que aplicar la migración 0012 antes de usarlos.",
      },
    });
  }

  const turno = await getOpenShiftForUser(db, auth.companyId, auth.userId);
  if (!turno) {
    const asignadas = auth.role === "cajero" ? await getCajasAsignadas(db, auth.companyId, auth.userId) : [];
    return c.json({ ok: true, data: { shift: null, assignedCajas: asignadas } });
  }

  return c.json({
    ok: true,
    data: {
      shift: {
        id: turno.id,
        locationId: turno.locationId,
        locationName: turno.location.name,
        startedAt: turno.startedAt,
        openingReadingId: turno.openingReadingId,
        baseCash: dinero(turno.baseCash),
      },
      assignedCajas: auth.role === "cajero" ? await getCajasAsignadas(db, auth.companyId, auth.userId) : [],
    },
  });
});

// POST /shift/start — abrir turno en una de las cajas asignadas.
shifts.post("/start", requireModule("pos"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ locationId?: string; baseCash?: Record<string, number> }>();
  const locationId = body.locationId;
  if (!locationId) return c.json({ ok: false, error: "Elige una caja para trabajar" }, 400);

  // Con cuánto dinero arranca la caja. Sin esto el cierre no tiene contra qué
  // comparar: un faltante de 200 no dice si es de este turno o venía de antes.
  const baseCash = dinero(body.baseCash || {});

  // El admin no necesita asignación: puede abrir turno en cualquier caja de su
  // empresa. Un cajero, solo en las que le hayan asignado.
  if (auth.role !== "admin") {
    const asignadas = await getCajasAsignadas(db, auth.companyId, auth.userId);
    if (!asignadas.some((a) => a.id === locationId)) {
      return c.json({ ok: false, error: "No tienes esa caja asignada. Pídele al administrador que te la asigne." }, 403);
    }
  }
  const location = await getActiveCompanyLocation(db, auth.companyId, locationId);
  if (!location || location.type !== "caja") {
    return c.json({ ok: false, error: "Esa caja no existe o está desactivada" }, 404);
  }

  // Una caja con turno abierto no se puede tomar. Sin esto, dos personas
  // podrían contar la misma caja a la vez y el inventario quedaría contado dos
  // veces.
  const ocupada = await getOpenShiftForLocation(db, auth.companyId, locationId);
  if (ocupada) {
    const otro = await db.select({ name: schema.users.name }).from(schema.users)
      .where(eq(schema.users.id, ocupada.userId)).get();
    return c.json({ ok: false, error: `Esa caja ya está en uso${otro?.name ? ` por ${otro.name}` : ""}. Ciérrale el turno o usa otra caja.` }, 409);
  }

  const yaTengo = await getOpenShiftForUser(db, auth.companyId, auth.userId);
  if (yaTengo) {
    return c.json({ ok: false, error: `Ya tienes un turno abierto en ${yaTengo.location.name}. Ciérralo antes de abrir otro.` }, 409);
  }

  // La lectura de apertura ES la foto del stock con la que arranca el turno.
  // Se crea aquí, en el servidor, para que sea la misma para todos los que
  // vean el turno.
  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).all();
  const stockRows = await db.select().from(schema.locationStock)
    .where(eq(schema.locationStock.locationId, location.id)).all();
  const stockBy = new Map(stockRows.map((r) => [r.productId, Number(r.qty)]));

  const readingId = generateUUID();
  const items = products.map((p) => ({
    productId: p.id, productCode: p.code, productName: p.name, unit: p.unit,
    qty: stockBy.get(p.id) ?? 0,
  }));

  const shiftId = generateUUID();
  // db.batch es una sola transacción: o queda el turno y su lectura, o no queda
  // ninguno. Nunca un turno abierto sin su punto de partida.
  //
  // EL ORDEN IMPORTA y no es cosa de estilo. shifts.opening_reading_id es una
  // clave foránea a inventory_readings, y SQLite comprueba las claves foráneas
  // en el momento de cada INSERT, no al cerrar la transacción. Si el turno va
  // primero, apunta a una lectura que todavía no existe y la base lo rechaza
  // con "FOREIGN KEY constraint failed": el turno no se abre y la pantalla
  // dice "error interno del servidor". Por eso la lectura va PRIMERO.
  //
  // Esto costó dos 500 seguidos. El primero era un cast que mentía sobre el
  // tipo de lo que se pasaba al lote, y tapaba este. Al arreglar el primero
  // apareció el segundo. Los dos estaban en la misma línea.
  await db.batch([
    db.insert(schema.inventoryReadings).values({
      id: readingId, companyId: auth.companyId, locationId: location.id, takenById: auth.userId,
      type: "apertura", notes: `Inicio de turno en ${location.name}`, items,
    }),
    db.insert(schema.shifts).values({
      id: shiftId, companyId: auth.companyId, locationId: location.id, userId: auth.userId,
      status: "abierto", openingReadingId: readingId, baseCash,
    }),
  ]);

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "shift.start", entity: "shift", entityId: shiftId,
    detail: { locationName: location.name }, ip: getClientIp(c),
  });

  return c.json({
    ok: true,
    data: {
      shift: { id: shiftId, locationId: location.id, locationName: location.name, startedAt: new Date(), openingReadingId: readingId, baseCash },
    },
  }, 201);
});

// POST /shift/end — cerrar el turno. El cierre de caja (contar) es un paso
// aparte y opcional: se puede cerrar el turno sin haber contado.
shifts.post("/end", requireAnyModule("pos", "cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const turno = await getOpenShiftForUser(db, auth.companyId, auth.userId);
  if (!turno) return c.json({ ok: false, error: "No tienes ningún turno abierto" }, 400);

  await db.update(schema.shifts)
    .set({ status: "cerrado", endedAt: new Date() })
    .where(eq(schema.shifts.id, turno.id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "shift.end", entity: "shift", entityId: turno.id,
    detail: { locationName: turno.location.name }, ip: getClientIp(c),
  });

  return c.json({ ok: true, data: { closed: turno.id } });
});

// ── Asignación de cajas (solo admin) ────────────────────────────────────────

// GET /shift/assignments/:userId — cajas asignadas a un cajero.
shifts.get("/assignments/:userId", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  return c.json({ ok: true, data: await getCajasAsignadas(db, auth.companyId, c.req.param("userId")) });
});

// PUT /shift/assignments/:userId — reemplazar el juego de cajas de un cajero.
// Se reemplaza entero (no se añade una a una) para que quitar una sea quitarla
// de verdad, y no "quedó a medio quitar".
shifts.put("/assignments/:userId", requireRole("admin"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const userId = c.req.param("userId");
  const body = await c.req.json<{ locationIds?: string[] }>();
  const pedidas: string[] = Array.isArray(body.locationIds) ? body.locationIds : [];

  const usuario = await db.select().from(schema.users)
    .where(and(eq(schema.users.id, userId), eq(schema.users.companyId, auth.companyId))).get();
  if (!usuario) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);

  // Validar que todas son cajas de ESTA empresa. Sin esto, alguien podría
  // asignar la caja de otra empresa metiendo un id ajeno.
  const validas: string[] = [];
  for (const id of pedidas) {
    const loc = await getActiveCompanyLocation(db, auth.companyId, id);
    if (!loc || loc.type !== "caja") continue;
    validas.push(id);
  }

  const actuales = await getCajasAsignadas(db, auth.companyId, userId);
  // Se arman primero las consultas y se ejecutan después, todas juntas y en
  // una sola transacción. El mismo error que en el inicio de turno: si se
  // ejecutan al construirlas, la asignación se guarda y la pantalla avisa de
  // que falló, que es peor que no avisar nada porque no se sabe si ocurrió.
  const stmts = [];
  for (const a of actuales) {
    if (!validas.includes(a.id)) {
      stmts.push(db.delete(schema.locationAssignments).where(and(
        eq(schema.locationAssignments.companyId, auth.companyId),
        eq(schema.locationAssignments.userId, userId),
        eq(schema.locationAssignments.locationId, a.id),
      )));
    }
  }
  for (const id of validas) {
    if (!actuales.some((a) => a.id === id)) {
      stmts.push(db.insert(schema.locationAssignments).values({
        id: generateUUID(), companyId: auth.companyId, userId, locationId: id,
      }));
    }
  }
  if (stmts.length) {
    // db.batch pide el tipo de una tupla con al menos un elemento. Acá ya se
    // comprobó que no está vacía, pero TypeScript no puede deducir eso de un
    // array. Este cast es SOLO de tipado: en ejecución se pasa el array tal
    // cual, sin truco ni trampa. (A diferencia del que había antes, que
    // mentía sobre lo que se pasaba en runtime.)
    await db.batch(stmts as [typeof stmts[number], ...typeof stmts[number][]]);
  }

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "shift.assign_boxes", entity: "user", entityId: userId,
    detail: { cajas: validas.length }, ip: getClientIp(c),
  });

  return c.json({ ok: true, data: await getCajasAsignadas(db, auth.companyId, userId) });
});

export default shifts;
