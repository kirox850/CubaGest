import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and, desc } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule, requireAnyModule, requireRole } from "../middleware/roles";
import { logAudit, getClientIp } from "../lib/audit";
import { generateUUID } from "../lib/jwt";
import {
  getCajasAsignadas, getOpenShiftForUser, getActiveCompanyLocation,
  turnosDisponiblesEn,
} from "../lib/locations";
import { dinero } from "../lib/cierreDinero";
import { stmtsFotoApertura } from "../lib/turnChain";
import { confirmarCierreHandler } from "./closing";

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
  // `items` es el conteo de apertura. Sin él, la foto sale copiada del stock: el
  // sistema se verifica a sí mismo y no cuenta nada. `businessAt` es la hora en la
  // que se CUENTA, no la de ahora, porque es la que fija hasta dónde llega la foto.
  const body = await c.req.json<{
    locationId?: string;
    baseCash?: Record<string, number>;
    items?: { productId: string; contado: number }[];
    businessAt?: string | number;
  }>();
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

  // EL TURNO ES DE LA PERSONA; LA CAJA ES DEL NEGOCIO.
  //
  // Antes una caja con turno abierto no se podía tomar, y con razón: si un
  // cierre se quedaba en la cola sin conexión, el turno seguía abierto y el
  // negocio quedaba parado hasta que volviera la red. Eso no puede ser.
  //
  // Ahora dos personas pueden tener turno abierto en la MISMA caja, y cada turno
  // lleva su propia lectura de apertura y su propio cierre. Que se counted dos
  // veces ya no es un problema porque la cadena de turnos (migración 0015) separa
  // el stock por hora de negocio: el segundo conteo no vuelve a descontar lo que
  // el primero ya tenía dentro.
  //
  // Lo que NO se permite sigue siendo lo importante: una misma persona con dos
  // turnos abiertos a la vez, que sí sería un error de verdad.

  const yaTengo = await getOpenShiftForUser(db, auth.companyId, auth.userId);
  if (yaTengo) {
    return c.json({ ok: false, error: `Ya tienes un turno abierto en ${yaTengo.location.name}. Ciérralo antes de abrir otro.` }, 409);
  }

  // ── La foto de apertura ──
  //
  // ANTES: aquí se copiaba el stock actual y se llamaba "lectura". El sistema se
  // copiaba a sí mismo y la caja quedaba sin verificar en cada cambio de turno.
  // Por eso el conteo real vivía en otra pantalla y nunca se disparaba.
  //
  // AHORA: es un conteo de verdad, con el mismo código que el resto de puertas
  // (stmtsFotoApertura). Si el negocio tiene activada la apertura heredada, se
  // copia la foto anterior y no se cuenta.
  //
  // OBLIGATORIO DE ABRIR, LIBRE DE RELLENAR: hay que pasar por aquí, pero el
  // cajero puede aceptar lo que ve tal cual. Eso es firma, no error: si luego hay
  // faltante, es de quien aceptó contar y no contó.
  const negocioEn = (() => {
    const b = body.businessAt;
    if (b === undefined || b === null || b === "") return new Date();
    const d = new Date(typeof b === "number" ? b : String(b));
    return Number.isFinite(d.getTime()) ? d : new Date();
  })();

  const readingId = generateUUID();
  const shiftId = generateUUID();

  const stmts = await stmtsFotoApertura(c.env.DB, {
    readingId,
    companyId: auth.companyId,
    locationId: location.id,
    userId: auth.userId,
    notas: `Inicio de turno en ${location.name}`,
    items: body.items,
    negocioEn,
  });

  stmts.push(
    // EL TURNO VA DESPUÉS de la foto, y no por estilo: shifts.opening_reading_id
    // es clave foránea a inventory_readings, y SQLite las comprueba en el momento
    // de cada INSERT, no al cerrar la transacción. Con el turno primero apuntaría
    // a una lectura que todavía no existe. Esto costó dos 500 seguidos.
    c.env.DB.prepare(
      `INSERT INTO shifts (id, company_id, location_id, user_id, status, opening_reading_id, base_cash, started_at)
       VALUES (?, ?, ?, ?, 'abierto', ?, ?, ?)`
    ).bind(
      shiftId, auth.companyId, location.id, auth.userId,
      readingId,
      // `base_cash` es una columna TEXT con modo JSON, y aquí NO pasa por Drizzle:
      // se escribe a mano porque el turno tiene que ir DESPUÉS de la foto (las
      // claves foráneas se comprueban en cada INSERT, no al cerrar el lote).
      //
      // Esa es la trampa: Drizzle serializa solo los campos `mode: "json"`, y al
      // escribir a mano eso no ocurre. El `bind()` de D1 solo admite null,
      // número, string y buffers — un objeto suelto lo rechaza con
      // D1_TYPE_ERROR y el turno entero se cae con 500. De ahí el
      // JSON.stringify explícito. Y `|| {}` en vez de `?? null`: la columna es
      // NOT NULL.
      JSON.stringify(baseCash || {}),
      Math.floor(negocioEn.getTime() / 1000)
    )
  );

  // Un solo lote: o queda el turno y su foto, o no queda ninguno. Nunca un turno
  // abierto sin su punto de partida, ni una foto de un turno que no llegó a abrir.
  await c.env.DB.batch(stmts);

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "shift.start", entity: "shift", entityId: shiftId,
    detail: {
      locationName: location.name,
      productosContados: Array.isArray(body.items) ? body.items.length : 0,
    }, ip: getClientIp(c),
  });

  return c.json({
    ok: true,
    data: {
      shift: { id: shiftId, locationId: location.id, locationName: location.name, startedAt: new Date(), openingReadingId: readingId, baseCash },
    },
  }, 201);
});

// POST /shift/end — terminar el turno.
//
// ANTES: cerraba el turno y ya. El cierre de caja era un paso aparte y OPCIONAL,
// en otra pantalla. Eso dejaba la cadena con turnos sin foto: el siguiente cajero
// abría contra la lectura de apertura de dos turnos antes y todo lo que pasó en
// medio se le endosaba a él.
//
// AHORA: terminar el turno ES hacer el cierre del periodo. Cuenta la caja, cierra
// la caja y concilia la cadena, sin que el cajero tenga que ir a otra pantalla a
// repetir el mismo trabajo. Se reutiliza el MISMO handler de /closing/confirm en
// vez de reescribir el cierre: dos maneras de cerrar un periodo es exactamente
// como una de las dos se queda sin conciliar.
//
// OBLIGATORIO DE TERMINAR, LIBRE DE RELLENAR: se pasa por el conteo, pero puede
// aceptarse tal cual. Firmar sin contar es una decisión, y si después hay faltante
// es de quien firmó.
shifts.post(
  "/end",
  requireAnyModule("pos", "cierre"),
  prepararCierreDeTurno,
  confirmarCierreHandler,
);

/**
 * Prepara el cierre al terminar el turno.
 *
 * Solo hace dos cosas, y las dos son validaciones: que el turno tenga foto de
 * apertura (sin ella no hay contra qué cerrar) y decir cuál es, para que el cierre
 * sepa que turno está cerrando y lo cierre en el mismo lote.
 *
 * Lo que viene después —contar, conciliar, ajustar— es el handler de /closing/confirm
 * tal cual. No se duplica aquí a propósito.
 */
async function prepararCierreDeTurno(
  c: Context<{ Bindings: Env; Variables: { initialReadingId?: string; shiftId?: string } }>,
  next: () => Promise<void>
) {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");

  const turno = await getOpenShiftForUser(db, auth.companyId, auth.userId);
  if (!turno) return c.json({ ok: false, error: "No tienes ningún turno abierto" }, 400);

  // Sin foto de apertura no hay contra qué cerrar. Antes esto pasaba en silencio:
  // el turno se cerraba igual y quedaba un hueco en la cadena.
  if (!turno.openingReadingId) {
    return c.json({
      ok: false,
      error: "Este turno no tiene conteo de apertura. No se puede cerrar un turno sin punto de partida.",
      code: "SHIFT_WITHOUT_READING",
    }, 409);
  }

  const body = await c.req.json<{
    items?: any[];
    countedCash?: Record<string, number>;
    countedAt?: string;
    notes?: string;
  }>().catch(() => ({}));

  // El turno manda su propia foto. El cierre la usa como periodo y cierra el turno
  // en el mismo lote, así que no hay ventana en la que uno esté y el otro no.
  // Se pasan por CONTEXTO, no reescribiendo `c.req.raw`.
//
// Lo que había aquí —leer el body, clonarlo con los campos del turno y meterlo
// en `c.req.raw`— no llegaba nunca al handler: Hono cachea el body ya parseado
// en el primer `c.req.json()`, así que cuando `confirmarCierreHandler` vuelve a
// pedirlo recibe SIEMPRE el original, sin los campos inyectados. De ahí el
// "initialReadingId requerido" al cerrar el turno: el middleware lo comprobaba
// (y pasaba el 409 si faltaba), pero su valor se perdía de camino.
c.set("initialReadingId", turno.openingReadingId);
c.set("shiftId", turno.id);

  await next();
}

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
