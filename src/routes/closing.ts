import { Hono } from "hono";
import type { Context } from "hono";
import { eq, and, gte, lte, desc, inArray } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";
import { generateUUID } from "../lib/jwt";
import { logAudit, getClientIp } from "../lib/audit";
import { notify, adminsOf } from "../lib/push";
import { resolveOwnLocation, getLocationStockQty, getActiveCompanyLocation } from "../lib/locations";
import {
  conciliar, dinero, estadoExplicaciones, venceProvisional, toleranciaDe, dentroDelMargen, margenAplicaA,
  lineasMercaderiaSinCuadrar, todoCuadra, MERCANCIA_TOLERANCIA,
  VENTANA_PROVISIONAL_HORAS,
} from "../lib/cierreDinero";
import { segundos, ahoraEnSegundos } from "../lib/fechas";
import { aperturaHeredada, stmtsFotoApertura } from "../lib/turnChain";
import { fotosDeLaCaja, esperadoDesdeFotoAnterior, reconciliarCaja } from "../lib/turnReconciler";
import {
  auditStmt,
  runBatch,
  errorMessage,
  ensureLocationStockStmt,
  // El conteo ajusta por diferencia, no sobrescribiendo el stock: por eso
  // aquí no se usa setStockStmt (ver la nota en el bucle de ajustes).
  incrementStockStmt,
  decrementStockStmt,
  recomputeProductStockStmt,
  stockMovementStmt,
} from "../lib/batch";

const closing = new Hono<{ Bindings: Env }>();

closing.use("*", authMiddleware);

// Ubicaciones que el usuario puede ver/operar en el módulo de cierre:
// admin ve todas (o filtra con ?locationId=), el resto solo la suya propia.
// El locationId que envía el admin se valida contra SU empresa: una caja de
// otra empresa no se responde, ni siquiera con datos vacíos.
async function resolveVisibleLocationIds(db: ReturnType<typeof drizzle>, auth: any, requestedLocationId?: string) {
  if (requestedLocationId) {
    const loc = await getActiveCompanyLocation(db, auth.companyId, requestedLocationId);
    return loc ? [loc.id] : [];
  }
  if (auth.role === "admin") {
    const all = await db.select({ id: schema.inventoryLocations.id }).from(schema.inventoryLocations)
      .where(eq(schema.inventoryLocations.companyId, auth.companyId)).all();
    return all.map((l) => l.id);
  }
  const own = await resolveOwnLocation(db, auth);
  return own ? [own.id] : [];
}

closing.get("/readings", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const { locationId } = c.req.query();
  const visibleIds = await resolveVisibleLocationIds(db, auth, locationId);
  if (visibleIds.length === 0) return c.json({ ok: true, data: [] });

  const rows = await db.select().from(schema.inventoryReadings)
    .where(and(
      eq(schema.inventoryReadings.companyId, auth.companyId),
      inArray(schema.inventoryReadings.locationId, visibleIds)
    ))
    .orderBy(desc(schema.inventoryReadings.createdAt))
    .limit(50).all();

  return c.json({ ok: true, data: rows.slice(0, 20) });
});

// Toma una lectura de apertura para UNA ubicación puntual. Sigue siendo solo
// para admin (igual que antes) — ahora hay que indicar cuál ubicación.
closing.post("/readings", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{
    locationId: string;
    notes?: string;
    items?: { productId: string; contado: number }[];
    businessAt?: string | number;
  }>();
  if (!body.locationId) return c.json({ ok: false, error: "locationId es requerido" }, 400);

  const location = await getActiveCompanyLocation(db, auth.companyId, body.locationId);
  if (!location) return c.json({ ok: false, error: "Ubicación no encontrada o inactiva" }, 404);
  if (!(await canAccessLocationId(db, auth, location.id))) {
    return c.json({ ok: false, error: "No tienes acceso a esa caja" }, 403);
  }

  const negocioEn = (() => {
    const b = body.businessAt;
    if (b === undefined || b === null || b === "") return new Date();
    const d = new Date(typeof b === "number" ? b : String(b));
    return Number.isFinite(d.getTime()) ? d : new Date();
  })();

  const readingId = generateUUID();

  // La MISMA función que usa /shift/start. Antes cada puerta escribía la foto a su
  // manera y solo una contaba; ahora no puede pasar.
  const stmts = await stmtsFotoApertura(c.env.DB, {
    readingId,
    companyId: auth.companyId,
    locationId: location.id,
    userId: auth.userId,
    notas: body.notes || null,
    items: body.items,
    negocioEn,
  });
  await c.env.DB.batch(stmts);

  const hereda = await aperturaHeredada(db, auth.companyId);
  const ajustados = await db.select({ items: schema.inventoryReadings.items })
    .from(schema.inventoryReadings)
    .where(eq(schema.inventoryReadings.id, readingId)).get();
  const filas: any[] = JSON.parse((ajustados?.items as any) || "[]");
  const productosAjustados = filas.filter((f) => Number(f.contado) !== Number(f.stockPrevio)).length;

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "closing.take_reading", entity: "inventory_reading", entityId: readingId,
    detail: { locationName: location.name, origen: hereda ? "heredado" : "contado", productosAjustados },
    ip: getClientIp(c),
  });

  const reading = await db.select().from(schema.inventoryReadings)
    .where(eq(schema.inventoryReadings.id, readingId)).get();

  return c.json({ ok: true, data: reading }, 201);
});

// ¿Puede este usuario operar sobre ESTA ubicación?
// admin: sí, si la ubicación es de su empresa. cajero/almacenista: solo la
// suya. Cualquier otra cosa (incluida una ubicación de otra empresa) → no.
async function canAccessLocationId(db: ReturnType<typeof drizzle>, auth: any, locationId: string) {
  const loc = await getActiveCompanyLocation(db, auth.companyId, locationId);
  if (!loc) return false;
  if (auth.role === "admin") return true;
  const own = await resolveOwnLocation(db, auth);
  return own?.id === loc.id;
}

async function loadInitialReading(db: ReturnType<typeof drizzle>, auth: any, initialReadingId: string) {
  const reading = await db.select().from(schema.inventoryReadings)
    .where(and(
      eq(schema.inventoryReadings.id, initialReadingId),
      eq(schema.inventoryReadings.companyId, auth.companyId)
    )).get();
  if (!reading) return null;
  if (!reading.locationId || !(await canAccessLocationId(db, auth, reading.locationId))) {
    return null;
  }
  return reading;
}

// El estado de la cadena de esta caja: qué foto hay, cuál falta, y qué se espera
// en la apertura siguiente.
//
// La UI lo usa para dos cosas: teachno que el cajerovee si lo que le dejaron no
// cuadra ANTES de empezar a contar, y avisar de que falta un eslabón para que
// faltantes no reales no se platiquen como si fueran de este turno.
closing.get("/chain/:locationId", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const locationId = c.req.param("locationId");
  if (!(await canAccessLocationId(db, auth, locationId))) {
    return c.json({ ok: false, error: "No tienes acceso a esa caja" }, 403);
  }

  const fotos = await fotosDeLaCaja(db, auth.companyId, locationId);
  const ultima = fotos.length ? fotos[fotos.length - 1] : null;

  // La comparación que toca ahora, si es una apertura.
  let esperado: { items: any[]; faltaEslabon: boolean; eslabonFaltante: string | null } | null = null;
  if (ultima) {
    const ahora = new Date();
    const { items } = await esperadoDesdeFotoAnterior(db, auth.companyId, locationId, ultima, {
      tipo: "apertura", id: "__preview__", at: ahora, items: [],
    });
    // ¿La vecina anterior de la última foto existe y se comparó? Si la última foto
    // es una apertura, su vecina tiene que ser un cierre. Si no hay ninguno, la
    // cadena empieza ahí y no falta nada: es la primera vez que se cuenta.
    const previa = fotos.length > 1 ? fotos[fotos.length - 2] : null;
    const hayCierrePrevio = fotos.some((f) => f.tipo === "cierre" && f.at.getTime() < ultima.at.getTime());
    const hayLecturaPrevia = fotos.some((f) => f.tipo === "apertura" && f.at.getTime() < ultima.at.getTime());
    const eslabonFaltante = !previa && ultima.tipo === "apertura" && !hayCierrePrevio ? null
      : (!hayCierrePrevio && hayLecturaPrevia ? "falta el cierre anterior de esta caja" : null);

    esperado = {
      items: Object.entries(items).map(([productId, diff]) => ({ productId, diff: Number(diff) })),
      faltaEslabon: !!eslabonFaltante,
      eslabonFaltante,
    };
  }

  const pendientes = await db.select().from(schema.turnReconciliations)
    .where(and(
      eq(schema.turnReconciliations.companyId, auth.companyId),
      eq(schema.turnReconciliations.locationId, locationId),
    )).orderBy(desc(schema.turnReconciliations.nextAt)).limit(20).all();

  return c.json({
    ok: true,
    data: {
      ultimaFoto: ultima ? { tipo: ultima.tipo, id: ultima.id, at: ultima.at, origen: ultima.origen } : null,
      totalFotos: fotos.length,
      esperado,
      comparaciones: (pendientes as any[]).map((x) => ({
        prevTipo: x.prevType, prevId: x.prevId,
        nextTipo: x.nextType, nextId: x.nextId,
        status: x.status, diffItems: x.diffItems, diffCash: x.diffCash,
        prevAt: x.prevAt, nextAt: x.nextAt, reconciledAt: x.reconciledAt,
      })),
      // El negocio puede tener el ajuste 2 activo: la apertura no cuenta.
      aperturaHeredada: await aperturaHeredada(db, auth.companyId),
    },
  });
});

closing.get("/preview/:initialReadingId", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const initialReadingId = c.req.param("initialReadingId");

  const initialReading = await loadInitialReading(db, auth, initialReadingId);
  if (!initialReading) {
    return c.json({ ok: false, error: "Lectura no encontrada o sin permisos sobre su ubicación" }, 404);
  }

  const periodStart = new Date(initialReading.createdAt!);
  const periodEnd = new Date();

  // Las ventas se filtran también por locationId — el cierre de cada cajero
  // solo cuenta SUS propias ventas, nunca las de otra caja.
  const sales = await db.select().from(schema.sales)
    .where(and(
      eq(schema.sales.companyId, auth.companyId),
      eq(schema.sales.locationId, initialReading.locationId),
      eq(schema.sales.status, "emitida"),
      gte(schema.sales.createdAt, periodStart),
      lte(schema.sales.createdAt, periodEnd),
    )).all();

  const saleIds = new Set(sales.map((s) => s.id));
  const allSaleItems = saleIds.size
    ? await db.select().from(schema.saleItems).where(inArray(schema.saleItems.saleId, Array.from(saleIds))).all()
    : [];
  const filteredSaleItems = allSaleItems.filter((si) => saleIds.has(si.saleId));

  const soldMap: Record<string, number> = {};
  const incomeMap: Record<string, number> = {};
  let totalIncome = 0;
  let incomeEfectivo = 0;
  let incomeTransferencia = 0;
  for (const sale of sales) {
    const amount = Number(sale.total);
    totalIncome += amount;
    if (sale.payMethod === "efectivo") incomeEfectivo += amount;
    else if (sale.payMethod === "transferencia") incomeTransferencia += amount;
  }
  for (const item of filteredSaleItems) {
    if (!item.productId) continue;
    soldMap[item.productId] = (soldMap[item.productId] || 0) + Number(item.qty);
    incomeMap[item.productId] = (incomeMap[item.productId] || 0) + Number(item.total);
  }

  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId), eq(schema.products.active, true))).all();

  const readingMap: Record<string, any> = {};
  for (const item of initialReading.items as any[]) readingMap[item.productId] = item;

  const resultItems: any[] = [];
  for (const p of products) {
    const ri = readingMap[p.id];
    const stockInitial = ri ? ri.qty : 0;
    const stockSold = soldMap[p.id] || 0;
    const stockExpected = parseFloat((stockInitial - stockSold).toFixed(3));
    // Stock ACTUAL en ESTA ubicación puntual, no el total de la empresa.
    const stockActual = await getLocationStockQty(db, initialReading.locationId!, p.id);
    const shortage = parseFloat((stockExpected - stockActual).toFixed(3));
    resultItems.push({
      productId: p.id,
      productCode: p.code,
      productName: p.name,
      unit: p.unit,
      price: Number(p.price),
      stockInitial,
      stockSold,
      stockExpected,
      stockValidated: stockActual,
      shortage,
      income: parseFloat((incomeMap[p.id] || 0).toFixed(2)),
    });
  }
  for (const ri of initialReading.items as any[]) {
    if (!products.find((p) => p.id === ri.productId)) {
      const stockSold = soldMap[ri.productId] || 0;
      const stockExpected = parseFloat((ri.qty - stockSold).toFixed(3));
      resultItems.push({
        productId: ri.productId,
        productCode: ri.productCode,
        productName: ri.productName + " (inactivo)",
        unit: ri.unit,
        price: 0,
        stockInitial: ri.qty,
        stockSold,
        stockExpected,
        stockValidated: 0,
        shortage: stockExpected,
        income: parseFloat((incomeMap[ri.productId] || 0).toFixed(2)),
      });
    }
  }

  // ── El dinero, para que la pantalla muestre lo que DEBERÍA haber ──
  // Con lo contado todavía en blanco: el preview no sabe qué va a contar el
  // cajero, solo cuánto hay y de dónde viene.
  const turnoPreview = await db.select().from(schema.shifts)
    .where(and(
      eq(schema.shifts.companyId, auth.companyId),
      eq(schema.shifts.locationId, initialReading.locationId!),
      eq(schema.shifts.openingReadingId, initialReading.id),
    )).get();
  const dineroPreview = await conciliar(db, auth.companyId, initialReading.locationId!, {
    periodStart, periodEnd,
    baseCash: dinero(turnoPreview?.baseCash),
    countedCash: {},
    shiftId: turnoPreview?.id ?? null,
  });

  return c.json({
    ok: true,
    data: {
      initialReading: { id: initialReading.id, type: initialReading.type, createdAt: initialReading.createdAt, notes: initialReading.notes, locationId: initialReading.locationId },
      periodStart,
      periodEnd,
      totalSales: sales.length,
      totalIncome: parseFloat(totalIncome.toFixed(2)),
      incomeEfectivo: parseFloat(incomeEfectivo.toFixed(2)),
      incomeTransferencia: parseFloat(incomeTransferencia.toFixed(2)),
      items: resultItems,
      // El dinero va aparte de los productos: se cuenta en la caja, no se
      // calcula con el catálogo. Y por moneda, nunca sumado.
      cash: {
        base: dineroPreview.base,
        ventas: dineroPreview.ventas,
        entradas: dineroPreview.entradas,
        salidas: dineroPreview.salidas,
        esperado: dineroPreview.esperado,
      },
      shiftId: turnoPreview?.id ?? null,
      baseCash: dinero(turnoPreview?.baseCash),
    },
  });
});

// POST /closing/confirm
// Reconciliación de INVENTARIO (el conteo físico ajusta el stock de la caja),
// no de caja física: el dinero se registra, no se cuenta.
// POST /closing/confirm
// Reconciliación de INVENTARIO (el conteo físico ajusta el stock de la caja),
// no de caja física: el dinero se registra, no se cuenta.
//
// Exportado y reutilizado por /shift/end: terminar el turno ES hacer el cierre del
// periodo. Se comparte el handler entero en vez de reescribir el cierre aquí, porque
// dos maneras distintas de cerrar un periodo es exactamente como una de las dos se
// queda sin conciliar.
export const confirmarCierreHandler = async (c: Context<{
  Bindings: Env;
  // Los rellena prepararCierreDeTurno (shifts.ts) al cerrar el turno. Opcionales
  // porque en un cierre directo no hay turno y los trae el body?.
  Variables: { initialReadingId?: string; shiftId?: string };
}>) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  // El turno aporta estos dos por CONTEXTO (ver prepararCierreDeTurno en shifts.ts).
  // Hono cachea el body en el primer `json()`, así que un middleware no puede
  // inyectar campos reescribiendo `c.req.raw`: el handler recibiría el body
  // original. Por eso van por `c.set`.
  const desdeTurno = c.get("initialReadingId") as string | undefined;
  const shiftDelTurno = c.get("shiftId") as string | undefined;
  const body = await c.req.json<{
    initialReadingId?: string; items: any[]; notes?: string;
    /** Lo que el cajero contó de dinero, por moneda: {"CUP":1200,"USD":20} */
    countedCash?: Record<string, number>;
    /** La HORA del conteo. Sin conexión puede ser horas anterior a cuando se
     *  sube, y de eso depende la ventana para explicar el descuadre. */
    countedAt?: string;
    /** Turno que cierra este conteo. Con él, el turno queda cerrado en el mismo
     *  lote que el cierre: o se guardan los dos, o no se guarda ninguno. */
    shiftId?: string;
  }>().catch(() => null);
  if (!body?.initialReadingId && !desdeTurno) return c.json({ ok: false, error: "initialReadingId es requerido" }, 400);

  // La guarda de arriba ya garantiza que hay id del turno o del body?.
  const initialReading = await loadInitialReading(
    db, auth, (body?.initialReadingId || desdeTurno) as string);
  if (!initialReading) {
    return c.json({ ok: false, error: "Lectura inicial no encontrada o sin permisos sobre su ubicación" }, 404);
  }
  const locationId = initialReading.locationId!;

  // ── El turno que se está cerrando ──
  // El cierre pertenece a un turno, no a "la última lectura sin usar". Con el
  // turno ligado, la lectura de apertura es obligatoriamente la de SU turno, y el
  // turno queda cerrado en el mismo lote que el cierre: si el cierre se queda en
  // la cola sin conexión, el turno sigue abierto y el siguiente cajero puede
  // tomar la caja.
  let turnoACerrar: typeof schema.shifts.$inferSelect | null = null;
  const shiftIdEfectivo = body?.shiftId || shiftDelTurno;
  if (shiftIdEfectivo) {
    turnoACerrar = await db.select().from(schema.shifts).where(and(
      eq(schema.shifts.id, shiftIdEfectivo),
      eq(schema.shifts.companyId, auth.companyId),
    )).get() ?? null;
    if (!turnoACerrar) {
      return c.json({ ok: false, error: "Ese turno no existe o no es de esta empresa" }, 400);
    }
    if (turnoACerrar.locationId !== locationId) {
      return c.json({ ok: false, error: "Ese turno es de otra caja. El cierre tiene que hacerse sobre la caja del turno." }, 400);
    }
    if (turnoACerrar.status === "cerrado") {
      return c.json({ ok: false, error: "Ese turno ya está cerrado", code: "SHIFT_ALREADY_CLOSED" }, 409);
    }
    // La lectura de apertura del cierre tiene que ser la de SU turno. Es lo que
    // impide asociar el cierre con el periodo equivocado cuando hay dos turnos
    // seguidos en la misma caja.
    if (turnoACerrar.openingReadingId && turnoACerrar.openingReadingId !== initialReading.id) {
      return c.json({
        ok: false,
        error: "Este cierre no se hizo sobre la lectura de apertura de su turno",
        code: "READING_NOT_FROM_SHIFT",
      }, 409);
    }
  }

  // ── Una lectura de apertura se confirma UNA vez ───────────────────────────
  // Antes se podía confirmar dos veces y se creaban dos cierres (y dos
  // ajustes de stock) sobre el mismo periodo. La garantía final es el índice
  // único parcial de cash_closings.confirm_key (migration 0007).
  const alreadyClosed = await db.select({ id: schema.cashClosings.id }).from(schema.cashClosings)
    .where(and(
      eq(schema.cashClosings.companyId, auth.companyId),
      eq(schema.cashClosings.confirmKey, initialReading.id)
    )).get();
  if (alreadyClosed) {
    return c.json(
      { ok: false, error: "Esta lectura de apertura ya se confirmó en un cierre anterior", code: "READING_ALREADY_CLOSED" },
      409
    );
  }

  // ── Conteo: solo productos de ESTA empresa ───────────────────────────────
  const submitted = Array.isArray(body?.items) ? body?.items : [];
  const submittedIds: string[] = [];
  for (const it of submitted) {
    const pid = it?.productId;
    if (typeof pid !== "string" || !pid) {
      return c.json({ ok: false, error: "Cada línea del conteo necesita un productId" }, 400);
    }
    const qty = Number(it.stockValidated);
    if (!Number.isFinite(qty) || qty < 0) {
      return c.json({ ok: false, error: `Cantidad contada inválida para ${pid}` }, 400);
    }
    submittedIds.push(pid);
  }

  if (submittedIds.length > 0) {
    // Ownership check: un productId de otra empresa (o inventado) se rechaza
    // ANTES de tocar nada. Antes esos IDs se colaban en el JSON del conteo y
    // cambiaban el stock de esta caja.
    const own = await db.select({ id: schema.products.id }).from(schema.products)
      .where(and(
        eq(schema.products.companyId, auth.companyId),
        inArray(schema.products.id, Array.from(new Set(submittedIds)))
      )).all();
    const ownIds = new Set(own.map((p) => p.id));
    const foreign = Array.from(new Set(submittedIds)).filter((id) => !ownIds.has(id));
    if (foreign.length > 0) {
      return c.json(
        { ok: false, error: `Algunos productos no pertenecen a tu empresa: ${foreign.join(", ")}`, code: "PRODUCT_NOT_IN_COMPANY" },
        400
      );
    }
  }

  // La hora del conteo la pone el cajero, no el servidor: si contó a las 8 y
  // subió el cierre al día siguiente por falta de internet, la ventana de 20
  // horas corre desde las 8. Si no se puede leer, se usa la del periodo.
  //
  // Va aquí y no más abajo porque el fin del período depende de ella: un cierre
  // encolado tiene que cerrar el turno que se contó, no el día que llegó.
  const countedAt = body?.countedAt && Number.isFinite(Date.parse(body?.countedAt))
    ? new Date(body?.countedAt)
    : new Date();

  const periodStart = new Date(initialReading.createdAt!);
  // El período termina cuando el cajero CONTÓ, no cuando el servidor recibió el
  // cierre. Es la misma regla que ya siguen las ventas: una venta hecha el lunes
  // sin conexión sigue siendo del lunes aunque llegue el martes (ver
  // `offlineTimestamp` en lib/sales.ts).
  //
  // Con `new Date()` un cierre encolado arrastraba todas las ventas de los días
  // que estuvo esperando en el dispositivo. Esas ventas sí caían dentro del
  // período, así que el esperado las incluía y el faltante salía fantasma: el
  // cajero contaba la caja del lunes y le decían que faltaba lo que se vendió el
  // martes.
  const periodEnd = countedAt ?? new Date();

  const sales = await db.select().from(schema.sales)
    .where(and(
      eq(schema.sales.companyId, auth.companyId),
      eq(schema.sales.locationId, locationId),
      eq(schema.sales.status, "emitida"),
      gte(schema.sales.createdAt, periodStart),
      lte(schema.sales.createdAt, periodEnd),
    )).all();

  const saleIds = new Set(sales.map((s) => s.id));
  const allSaleItems = saleIds.size
    ? await db.select().from(schema.saleItems).where(inArray(schema.saleItems.saleId, Array.from(saleIds))).all()
    : [];
  const filteredSaleItems = allSaleItems.filter((si) => saleIds.has(si.saleId));

  const soldMap: Record<string, number> = {};
  const incomeMap: Record<string, number> = {};
  let totalIncome = 0;
  let incomeEfectivo = 0;
  let incomeTransferencia = 0;
  for (const sale of sales) {
    const amount = Number(sale.total);
    totalIncome += amount;
    if (sale.payMethod === "efectivo") incomeEfectivo += amount;
    else if (sale.payMethod === "transferencia") incomeTransferencia += amount;
  }
  for (const item of filteredSaleItems) {
    if (!item.productId) continue;
    soldMap[item.productId] = (soldMap[item.productId] || 0) + Number(item.qty);
    incomeMap[item.productId] = (incomeMap[item.productId] || 0) + Number(item.total);
  }

  const validatedMap: Record<string, number> = {};
  for (const item of submitted) validatedMap[item.productId] = Math.round(Number(item.stockValidated) * 1000) / 1000;

  const readingMap: Record<string, any> = {};
  for (const ri of initialReading.items as any[]) readingMap[ri.productId] = ri;

  const allProductIds = new Set([
    ...Object.keys(readingMap),
    ...Object.keys(soldMap),
    ...Object.keys(validatedMap),
  ]);

  const closingItems: any[] = [];
  for (const pid of allProductIds) {
    const ri = readingMap[pid];
    const stockInitial = ri ? Number(ri.qty) : 0;
    const stockSold = soldMap[pid] || 0;
    const stockExpected = parseFloat((stockInitial - stockSold).toFixed(3));
    const stockValidated = validatedMap[pid] !== undefined ? validatedMap[pid] : stockExpected;
    const shortage = parseFloat((stockExpected - stockValidated).toFixed(3));
    closingItems.push({
      productId: pid,
      productCode: ri?.productCode || "",
      productName: ri?.productName || "",
      unit: ri?.unit || "ud",
      price: 0,
      stockInitial,
      stockSold,
      stockExpected,
      stockValidated,
      shortage,
      income: parseFloat((incomeMap[pid] || 0).toFixed(2)),
    });
  }

  const closingReadingItems = closingItems
    .filter((i) => i.stockValidated >= 0)
    .map((i) => ({
      productId: i.productId,
      productCode: i.productCode,
      productName: i.productName,
      unit: i.unit,
      qty: i.stockValidated,
    }));

  // ── El dinero ───────────────────────────────────────────────────────────
  // El turno es el que sabe con cuánto dinero empezó la caja. Si no hay turno
  // (un cierre viejo, o un admin cerrando sin haber abierto turno) se usa el
  // fondo de la lectura de apertura, que es lo mejor que hay.
  const turnoCierre = await db.select().from(schema.shifts)
    .where(and(
      eq(schema.shifts.companyId, auth.companyId),
      eq(schema.shifts.locationId, locationId),
      eq(schema.shifts.openingReadingId, initialReading.id),
    )).get();
  const shiftId = turnoCierre?.id ?? null;
  const baseCash = dinero(turnoCierre?.baseCash);
  const countedCash = dinero(body?.countedCash);

  // Si no llega dinero contado, NO se calcula el descuadre. Hay dos caminos
  // que llegan aquí sin dinero: un cliente viejo que no conoce esta pantalla,
  // y un cierre encolado sin conexión desde antes de que existiera. Comparar
  // "lo contado = 0" contra 17 500 de esperado daría un faltante enorme y
  // FALSO, y dejaría el cierre provisional esperando una explicación
  // que nadie puede dar porque nunca contó nada. Es mucho más honesto no
  // reconciliar el dinero que inventar un descuadre.
  const hayDineroContado = Object.keys(countedCash).length > 0;
  const tolerancia = await toleranciaDe(db, auth.companyId);
  const conciliacion = hayDineroContado
    ? await conciliar(db, auth.companyId, locationId, {
        periodStart, periodEnd, baseCash, countedCash, shiftId, tolerancia,
      })
    : {
        base: baseCash, ventas: {}, entradas: {}, salidas: {},
        esperado: {}, contado: {}, diff: {}, diffBloqueante: {}, descuadra: false,
      };

  // ── ¿Queda alguna línea sin cuadrar? ──
  // El cierre entra en pendiente si falta o sobra CUALQUIER cosa. Antes solo
  // contaba el dinero, y un cierre con 3 cigarettes de menos pasaba por
  // limpio. Y el dinero pasa el filtro del margen del negocio: una diferencia
  // dentro de lo que el dueño considera ruido no es un problema suyo.
  const mercaderiaSinCuadrar = lineasMercaderiaSinCuadrar(closingItems);
  const quedaAlgo = conciliacion.diffBloqueante && Object.keys(conciliacion.diffBloqueante).length > 0
    || mercaderiaSinCuadrar.length > 0;

  const closingReadingId = generateUUID();
  const closingId = generateUUID();
  const totalSales = sales.length;
  const totalIncomeR = parseFloat(totalIncome.toFixed(2));
  const incomeEfectivoR = parseFloat(incomeEfectivo.toFixed(2));
  const incomeTransferenciaR = parseFloat(incomeTransferencia.toFixed(2));
  const hasShortage = closingItems.some((i) => i.shortage > 0.001);

  // ── Escritura atómica ────────────────────────────────────────────────────
  // Un solo batch: el cierre, su lectura final, el ajuste de stock de cada
  // producto contado y los totales de empresa. Si algo falla, no queda un
  // cierre a medias ni un stock movido sin registro.
  const stmts: D1PreparedStatement[] = [
    // LA LECTURA VA PRIMERO, y el motivo es el mismo que en el inicio de turno:
    // cash_closings.closing_reading_id es clave foránea a inventory_readings, y
    // SQLite comprueba las claves foráneas en el momento de cada INSERT, no al
    // cerrar la transacción. Con el cierre antes, apuntaba a una lectura que
    // todavía no existía y D1 devolvía "FOREIGN KEY constraint failed".
    c.env.DB.prepare(
      `INSERT INTO inventory_readings (id, company_id, location_id, taken_by_id, type, notes, items, origen, is_opening, created_at)
       VALUES (?, ?, ?, ?, 'cierre', ?, ?, 'contado', 0, ?)`
    ).bind(
      closingReadingId, auth.companyId, locationId, auth.userId,
      "Generada automaticamente al cierre", JSON.stringify(closingReadingItems), ahoraEnSegundos()
    ),
    c.env.DB.prepare(
      `INSERT INTO cash_closings (id, company_id, location_id, closed_by_id, initial_reading_id,
                                  closing_reading_id, confirm_key, period_start, period_end,
                                  total_sales, total_income, income_efectivo, income_transferencia,
                                  items, base_cash, counted_cash, expected_cash, cash_diff,
                                  status, counted_at, provisional_until, shift_id,
                                  notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      closingId, auth.companyId, locationId, auth.userId, initialReading.id,
      closingReadingId, initialReading.id,
      // period_start/period_end en MILISEGUNDOS: el esquema los declara
      // { mode: "timestamp" }, que lee milisegundos. Antes se guardaban en
      // segundos (unixepoch) y todo cierre histórico salía fechado en 1970.
      // La migración 0013 repara los que ya estaban mal.
      segundos(periodStart), segundos(periodEnd),
      totalSales, totalIncomeR, incomeEfectivoR, incomeTransferenciaR,
      JSON.stringify(closingItems),
      JSON.stringify(conciliacion.base), JSON.stringify(conciliacion.contado),
      JSON.stringify(conciliacion.esperado),
      // Se guarda la diferencia REAL, no solo la que supera el margen: si el
      // dueño pone 500 de margen, un faltante de 200 sigue siendo un
      // faltante de 200 y el historial tiene que decirlo así.
      JSON.stringify(conciliacion.diff),
      // Si el dinero no cuadra, el cierre queda PROVISIONAL: existe, no se
      // pierde, pero espera una explicación. Si cuadra, se cierra de una vez.
      quedaAlgo ? "provisional" : "cerrado",
      segundos(countedAt),
      quedaAlgo ? segundos(venceProvisional(countedAt, new Date())) : null,
      shiftId,
      (body?.notes || "").trim() || null,
      ahoraEnSegundos()
    ),

  ];

  for (const item of closingItems) {
    if (validatedMap[item.productId] === undefined) continue;
    const current = await getLocationStockQty(db, locationId, item.productId);
    const delta = validatedMap[item.productId] - current;
    if (Math.abs(delta) < 0.0005) continue;
    // OJO: aquí se aplicaba setStockStmt, que ESCRIBE el stock con la cantidad
    // contada. Eso parte de la foto del conteo, y en cuanto llegara una venta
    // de ese periodo (una venta offline que sube tarde, un traspaso) esa venta
    // descontaría de un stock que ya no era el real, y el inventario quedaría
    // corrupto para siempre sin que nada lo delatara.
    //
    // Ahora el conteo es un MOVIMIENTO en el libro: se suma o se resta la
    // diferencia sobre el stock de este instante. Una venta que llegue después
    // descuenta de verdad, y los dos hechos son ciertos.
    stmts.push(
      ensureLocationStockStmt(c.env.DB, locationId, item.productId),
      delta > 0
        ? incrementStockStmt(c.env.DB, locationId, item.productId, delta)
        : decrementStockStmt(c.env.DB, locationId, item.productId, -delta),
      stockMovementStmt(c.env.DB, {
        companyId: auth.companyId,
        productId: item.productId,
        userId: auth.userId,
        locationId,
        type: "ajuste",
        qty: delta,
        reason: "Cierre de inventario (conteo físico)",
      }),
      recomputeProductStockStmt(c.env.DB, item.productId)
    );
  }

  // El cierre ES una foto de la caja: a partir de su hora, lo que llegue con
  // una hora anterior ya está dentro del número contado. Sin esto, una venta
  // tardía volvería a descontar lo que el cajero ya contó como faltante.
  stmts.push(
    c.env.DB.prepare(`UPDATE inventory_locations SET last_snapshot_at = ? WHERE id = ?`)
      .bind(Math.floor((countedAt ?? new Date()).getTime() / 1000), locationId)
  );

  // Cerrar el turno en el MISMO lote que el cierre. Si el cierre se queda en la
  // cola sin conexión, este lote no corre y el turno sigue abierto: el siguiente
  // cajero puede tomar la caja y el negocio no se para.
  if (turnoACerrar) {
    stmts.push(
      c.env.DB.prepare(
        `UPDATE shifts SET status = 'cerrado', ended_at = ?, closing_id = ? WHERE id = ?`
      ).bind(Math.floor((countedAt ?? new Date()).getTime() / 1000), closingId, turnoACerrar.id)
    );
  }

  stmts.push(
    auditStmt(c.env.DB, {
      companyId: auth.companyId, userId: auth.userId,
      action: "closing.confirm", entity: "cash_closing", entityId: closingId,
      detail: {
        locationId, totalSales, totalIncome: totalIncomeR, hasShortage,
        shortageItems: closingItems.filter((i) => i.shortage > 0.001).map((i) => ({ product: i.productName, shortage: i.shortage })),
      },
      ip: getClientIp(c),
    })
  );

  try {
    await runBatch(c.env.DB, stmts);
  } catch (err) {
    const msg = errorMessage(err);
    console.error("closing/confirm: batch falló y se revirtió:", msg);
    if (/cash_closings\.confirm_key/i.test(msg)) {
      return c.json(
        { ok: false, error: "Esta lectura de apertura ya se confirmó en un cierre anterior", code: "READING_ALREADY_CLOSED" },
        409
      );
    }
    return c.json({ ok: false, error: "No se pudo registrar el cierre. Inténtalo de nuevo.", code: "CLOSING_COMMIT_FAILED" }, 503);
  }

  const closingRecord = await db.select().from(schema.cashClosings)
    .where(eq(schema.cashClosings.id, closingId)).get();

  // El cierreGUARDÓ bien, pero el conteo físico no cuadró. Eso no es un error
  // técnico: es dinero que falta, y quien tiene que enterarse es el dueño, no
  // el cajero que ya cerró su turno. Se avisa a los admins de la empresa.
  if (hasShortage) {
    const faltantes = closingItems.filter((i) => i.shortage > 0.001);
    // Sin monto: aquí no está el precio unitario, y un importe estimado en un
    // aviso sobre el que el dueño va a actuar es peor que no poner nada. Lo
    // que sí es exacto es cuántas unidades faltaron.
    const unidades = faltantes.reduce((a, i) => a + i.shortage, 0);
    const detalle = faltantes.length === 1
      ? `${Math.round(faltantes[0].shortage * 100) / 100} ${faltantes[0].unit || "ud"} de ${faltantes[0].productName}`
      : `${Math.round(unidades * 100) / 100} unidades en ${faltantes.length} productos`;
    const loc = await getActiveCompanyLocation(db, auth.companyId, locationId);
    const nombreUbicacion = loc?.name ?? "el cierre";
    const paraAdmins = await adminsOf(db, auth.companyId);
    if (paraAdmins.length > 0) {
      void notify({
        env: c.env,
        db,
        companyId: auth.companyId,
        userIds: paraAdmins,
        type: "closing.shortage",
        title: "Cierre de caja con faltante",
        body: `Faltante en ${nombreUbicacion}: ${detalle}. Revísalo hoy.`,
        link: "/closing",
        data: { closingId, kind: "closing.shortage" },
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      });
    }
  }

  // ── Conciliar la cadena de turnos ──
  // El cierre es una foto más de la caja. Al guardarla, se resuelve su comparación
  // con la foto anterior y queda anotada en turn_reconciliations, para que el
  // siguiente turno vea el descuadre como lo que es —de este periodo— y no como
  // una caja que llega mal.
  //
  // NO ajusta stock: la foto ya lo ajustó al llegar. Esto solo detecta y anota.
  // Y si falla, el cierre sigue guardado: la conciliación se reintenta en el
  // siguiente ciclo y en el barrido del cron.
  let conciliacionCadena = { compared: 0, pending: 0, different: 0 };
  try {
    conciliacionCadena = await reconciliarCaja(db, auth.companyId, locationId);
  } catch (e) {
    console.error("reconciliarCaja tras el cierre falló:", e);
  }

  return c.json({ ok: true, data: closingRecord, conciliacionCadena }, 201);
};
// POST /closing/confirm — confirmar el conteo y conciliar la cadena.
//
// Esta ruta SE PERDIÓ en la refactorización de 47115cb: al extraer el cuerpo a un
// handler exportable para reutilizarlo desde /shift/end, se SUSTITUYÓ la ruta
// por el handler y no se volvió a registrar. El handler siguió exportado y
// /shift/end siguió consumiéndolo, así que cerrar turno seguía por su camino
// mientras que los cierres directos se comían un 404. Web y móvil llaman a esta
// ruta en ambos casos.
//
// Va aquí y no junto al handler porque tiene que declararse DESPUÉS de que
// `confirmarCierreHandler` exista. Sin middleware: `prepararCierreDeTurno` es
// solo de /shift/end, que ya valida lo suyo antes de llamar al handler.
closing.post("/confirm", requireModule("cierre"), confirmarCierreHandler);

closing.get("/", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  // Antes de mostrar la lista, se cierran los provisionales que ya vencieron:
  // si no, la pantalla diría "provisional" de algo que en realidad ya cerró,
  // y el dueño vería un descuadre_old sin resolver que ya tiene notificación.
  await cerrarProvisionalesVencidos(db, c.env, auth.companyId);
  const { locationId } = c.req.query();
  const visibleIds = await resolveVisibleLocationIds(db, auth, locationId);
  if (visibleIds.length === 0) return c.json({ ok: true, data: [] });

  const rows = await db.select().from(schema.cashClosings)
    .where(and(
      eq(schema.cashClosings.companyId, auth.companyId),
      inArray(schema.cashClosings.locationId, visibleIds)
    ))
    .orderBy(desc(schema.cashClosings.createdAt))
    .limit(50).all();

  return c.json({ ok: true, data: rows });
});

closing.get("/:id", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const row = await db.select().from(schema.cashClosings)
    .where(and(eq(schema.cashClosings.id, id), eq(schema.cashClosings.companyId, auth.companyId))).get();
  if (!row) return c.json({ ok: false, error: "Cierre no encontrado" }, 404);
  if (!row.locationId || !(await canAccessLocationId(db, auth, row.locationId))) {
    return c.json({ ok: false, error: "No tiene permisos sobre la ubicación de este cierre" }, 403);
  }

  // Las notas y las explicaciones van aparte, con quién las escribió: una
  // nota sin autor no sirve de nada cuando alguien pregunte "y esto qué fue".
  const [notas, explicaciones] = await Promise.all([
    db.select({ n: schema.closingNotes, autor: schema.users.name })
      .from(schema.closingNotes)
      .innerJoin(schema.users, eq(schema.closingNotes.createdById, schema.users.id))
      .where(eq(schema.closingNotes.closingId, id)).all(),
    db.select({ e: schema.closingExplanations, autor: schema.users.name })
      .from(schema.closingExplanations)
      .innerJoin(schema.users, eq(schema.closingExplanations.createdById, schema.users.id))
      .where(eq(schema.closingExplanations.closingId, id)).all(),
  ]);

  // Lo que le queda por cuadrar a este cierre, ya descontado lo explicado.
  const tolerancia = await toleranciaDe(db, auth.companyId);
  const esperado = dinero(row.expectedCash);
  const pendientesDinero: Record<string, number> = {};
  for (const [k, v] of Object.entries(dinero(row.cashDiff))) {
    if (margenAplicaA(k, tolerancia) && dentroDelMargen(v, tolerancia!.modo, tolerancia!.valor, esperado[k] || 0)) continue;
    pendientesDinero[k] = v;
  }
  const pendientesMercaderia = lineasMercaderiaSinCuadrar((row.items as any[]) || []);

  return c.json({
    ok: true,
    data: {
      ...row,
      notas: notas.map((x) => ({
        id: x.n.id, productId: x.n.productId, productName: x.n.productName,
        qty: Number(x.n.qty), note: x.n.note, autor: x.autor, createdAt: x.n.createdAt,
      })),
      explicaciones: explicaciones.map((x) => ({
        id: x.e.id, currency: x.e.currency, amount: Number(x.e.amount),
        note: x.e.note, autor: x.autor, createdAt: x.e.createdAt,
      })),
      // Lo que sigue abierto. La pantalla no lo deduce: se lo dice el
      // servidor, que es quien sabe qué está explicado y qué no.
      pendientes: {
        dinero: pendientesDinero,
        mercaderia: pendientesMercaderia.map((l: any) => ({
          productId: l.productId, productName: l.productName,
          unit: l.unit, shortage: Number(l.shortage),
        })),
      },
    },
  });
});

export default closing;

// ─── EXPLICAR UN DESCUADRE ──────────────────────────────────────────────────
//
// Un cierre provisional no está mal: está esperando que alguien diga cuánto
// faltaba y por qué. Eso puede ser un cobro mal hecho, un cambio que se le
// olvidó a alguien, un producto perdido. Y también puede ser un robo, que es
// justo lo que el dueño tiene que poder ver.
//
// La regla acordada: la explicación tiene que coincidir con la cantidad EXACTA
// del descuadre para resolverlo. Una explicación de 300 no resuelve un faltante
// de 297, aunque se parezca. Se acepta lo que cuadra al peso, porque un cierre
// de caja sirve justamente para que las cuentas cuadren.
closing.post("/:id/explain", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = await c.req.json<{ currency?: string; amount?: number; note?: string }>().catch(() => null);

  const closing = await db.select().from(schema.cashClosings)
    .where(and(eq(schema.cashClosings.id, id), eq(schema.cashClosings.companyId, auth.companyId))).get();
  if (!closing) return c.json({ ok: false, error: "Cierre no encontrado" }, 404);

  if (!(await canAccessLocationId(db, auth, closing.locationId))) {
    return c.json({ ok: false, error: "No tienes acceso a esa caja" }, 403);
  }
  if (closing.status !== "provisional") {
    return c.json({ ok: false, error: "Ese cierre ya no está esperando explicaciones" }, 409);
  }

  // Lo que hay que explicar es lo que supera el margen: una diferencia que el
  // dueño ya acepta como ruido no es un descuadre pendiente de explicación.
  const tolerancia = await toleranciaDe(db, auth.companyId);
  const diff = dinero(closing.cashDiff);
  const diffBloqueante: Record<string, number> = {};
  for (const [k, v] of Object.entries(diff)) {
    if (margenAplicaA(k, tolerancia) && dentroDelMargen(v, tolerancia!.modo, tolerancia!.valor, dinero(closing.expectedCash)[k] || 0)) continue;
    diffBloqueante[k] = v;
  }
  const currency = (body?.currency || "").toUpperCase().slice(0, 8);
  const amount = Number(body?.amount);
  if (!currency || !Number.isFinite(amount) || amount === 0) {
    return c.json({ ok: false, error: "Indica la moneda y la cantidad" }, 400);
  }
  // La moneda tiene que ser una de las que realmente descuadran: explicar el
  // CUP de un cierre que solo descuadra en USD es un error de dedo que
  // quedaría guardado para siempre en el historial.
  if (!(currency in diffBloqueante)) {
    return c.json({ ok: false, error: `Ese cierre no tiene un descuadre pendiente en ${currency}` }, 400);
  }
  if (Math.abs(Math.abs(amount) - Math.abs(diffBloqueante[currency])) > 0.005) {
    return c.json({
      ok: false,
      error: `La diferencia es de ${Math.abs(diffBloqueante[currency])} ${currency}. La explicación tiene que coincidir exactamente.`,
      code: "AMOUNT_MISMATCH",
    }, 400);
  }
  const nota = (body?.note || "").trim();
  if (!nota) return c.json({ ok: false, error: "Escribe qué pasó" }, 400);

  const explicacionId = generateUUID();
  // La consulta va sin ejecutar: si se ejecuta al construirla y luego falla el
  // lote, la explicación queda guardada y el cierre nunca pasa a "resuelto",
  // que era lo que pasaba.
  await db.batch([
    db.insert(schema.closingExplanations).values({
      id: explicacionId, companyId: auth.companyId, closingId: id,
      currency, amount: Math.abs(amount), note: nota, createdById: auth.userId,
    }),
  ]);

  // ¿Con esto ya cuadró TODO? Un cierre se resuelve cuando todas sus líneas
  // cuadran: el dinero explicado Y la mercancía contada. La moneda recién
  // explicada sale del descuadre antes de preguntar por las demás, o seguiría
  // apareciendo como pendiente y el cierre nunca cerraría.
  const diffRestante: Record<string, number> = { ...diffBloqueante };
  delete diffRestante[currency];
  const estado = await estadoExplicaciones(db, id, diffRestante);
  // El dinero que sigue sin explicar...
  const quedanDinero = estado.pendientes;
  // ...y la mercancía que no cuadra. Una nota NO cuenta aquí: es el relato de
  // por qué faltó, no una línea cuadrada. Un cierre con faltante de
  // mercadería no se resuelve escribiendo por qué, se resuelve cuando la
  // mercancía cuadre.
  const quedan = [
    ...quedanDinero.map((k) => `dinero:${k}`),
    ...lineasMercaderiaSinCuadrar((closing.items as any[]) || []).map((l: any) => `mercaderia:${l.productId}`),
  ];
  const nuevoStatus = quedan.length === 0 ? "resuelto" : "provisional";

  await db.update(schema.cashClosings)
    .set({ status: nuevoStatus, provisionalUntil: quedan.length === 0 ? null : closing.provisionalUntil })
    .where(eq(schema.cashClosings.id, id));

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "closing.explain", entity: "cash_closing", entityId: id,
    detail: { currency, amount: Math.abs(amount), note: nota, quedan }, ip: getClientIp(c),
  });

  // Si con esto se resolvió todo, el dueño tiene que enterarse de que ya
  // está claro. Un aviso que solo dice "hubo un problema" y nunca dice "se
  // resolvió" hace que la gente deje de mirar los avisos.
  if (nuevoStatus === "resuelto") {
    const paraAdmins = await adminsOf(db, auth.companyId);
    if (paraAdmins.length) {
      const loc = await getActiveCompanyLocation(db, auth.companyId, closing.locationId);
      void notify({
        env: c.env, db, companyId: auth.companyId, userIds: paraAdmins,
        type: "closing.resolved",
        title: "Cierre de caja resuelto",
        body: `Se explicó el descuadre de ${loc?.name || "la caja"} y el cierre quedó cuadrado.`,
        link: "/cierre",
        data: { closingId: id, kind: "closing.resolved" },
        waitUntil: (p) => c.executionCtx.waitUntil(p),
      });
    }
  }

  return c.json({ ok: true, data: { id: explicacionId, status: nuevoStatus, quedan } }, 201);
});

/**
 * Cierra los provisionales que ya vencieron.
 *
 * Se llama en dos sitios: cuando alguien mira la lista de cierres (así el
 * número que ve siempre es real) y desde el cron diario (para que el aviso
 * salga aunque nadie abra la aplicación en 20 horas).
 */
export async function cerrarProvisionalesVencidos(db: any, env: Env, companyId?: string) {
  const ahora = Date.now();
  const vencidos = await db.select().from(schema.cashClosings)
    .where(and(
      ...(companyId ? [eq(schema.cashClosings.companyId, companyId)] : []),
      eq(schema.cashClosings.status, "provisional"),
    )).all()
    .then((rows: any[]) => rows.filter((r: any) => r.provisionalUntil && new Date(r.provisionalUntil).getTime() <= ahora));

  for (const c of vencidos) {
    const diff = dinero(c.cashDiff);
    const mercaderia = lineasMercaderiaSinCuadrar((c.items as any[]) || []);
    await db.update(schema.cashClosings)
      .set({ status: "cerrado", provisionalUntil: null })
      .where(eq(schema.cashClosings.id, c.id));
    await db.insert(schema.auditLogs).values({
      id: generateUUID(), companyId: c.companyId, userId: null,
      action: "closing.provisional_expired", entity: "cash_closing", entityId: c.id,
      detail: { diff, mercaderia: mercaderia.length, ventanaHoras: VENTANA_PROVISIONAL_HORAS },
      createdAt: new Date(),
    }).run();
    const admins = await adminsOf(db, c.companyId);
    if (admins.length) {
      const loc = await getActiveCompanyLocation(db, c.companyId, c.locationId);
      // Se listan las dos clases de línea. Antes este aviso solo hablaba de
      // dinero, así que un cierre que venció con mercancía faltante avisaba
      // de "0 CUP" o directamente no avisaba: el dueño se quedaba sin saber
      // de qué tenía que enterarse.
      const detalle = [
        ...Object.entries(diff).map(([k, v]) => `${Math.abs(v)} ${k} ${v < 0 ? "faltante" : "sobrante"}`),
        ...mercaderia.slice(0, 3).map((l: any) =>
          `${Math.abs(Number(l.shortage) * 100) / 100} ${l.unit || "ud"} de ${l.productName} ${Number(l.shortage) > 0 ? "faltante" : "sobrante"}`),
        ...(mercaderia.length > 3 ? [`y ${mercaderia.length - 3} producto(s) más`] : []),
      ].join(", ") || "algo sin cuadrar";
      void notify({
        env, db, companyId: c.companyId, userIds: admins,
        type: "closing.expired",
        title: "Cierre de caja sin resolver",
        body: `En ${loc?.name || "la caja"} pasaron ${VENTANA_PROVISIONAL_HORAS} horas sin resolverse: ${detalle}.`,
        link: "/cierre",
        data: { closingId: c.id, kind: "closing.expired" },
      });
    }
  }
  return vencidos.length;
}

/**
 * POST /closing/:id/note — por qué faltó o sobró mercancía.
 *
 * NO resuelve nada. Es una nota: el dueño la lee tres meses después, cuando
 * alguien pregunta por qué faltabamercancía en aquel cierre, y está ahí la
 * respuesta. El cierre sigue pendiente hasta que la mercancía cuadre, porque
 * escribir por qué pasó no hace que pase menos.
 */
closing.post("/:id/note", requireModule("cierre"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const id = c.req.param("id");
  const body = await c.req.json<{ productId?: string; qty?: number; note?: string }>().catch(() => null);

  const closing = await db.select().from(schema.cashClosings)
    .where(and(eq(schema.cashClosings.id, id), eq(schema.cashClosings.companyId, auth.companyId))).get();
  if (!closing) return c.json({ ok: false, error: "Cierre no encontrado" }, 404);
  if (!(await canAccessLocationId(db, auth, closing.locationId))) {
    return c.json({ ok: false, error: "No tienes acceso a esa caja" }, 403);
  }

  const texto = (body?.note || "").trim();
  if (!texto) return c.json({ ok: false, error: "Escribe la nota" }, 400);

  const items = (closing.items as any[]) || [];
  const linea = body?.productId ? items.find((i) => i.productId === body?.productId) : null;
  // Sin productId es una nota general sobre el cierre; con productId, queda
  // atada a la línea, que es donde se va a mirar.
  if (body?.productId && !linea) {
    return c.json({ ok: false, error: "Ese producto no está en este cierre" }, 400);
  }

  const notaId = generateUUID();
  await db.insert(schema.closingNotes).values({
    id: notaId, companyId: auth.companyId, closingId: id,
    productId: body?.productId || null,
    productName: linea?.productName || null,
    qty: linea ? Math.abs(Number(linea.shortage) || 0) : 0,
    note: texto, createdById: auth.userId,
  }).run();

  await logAudit(c.env, {
    companyId: auth.companyId, userId: auth.userId,
    action: "closing.note", entity: "cash_closing", entityId: id,
    detail: { productId: body?.productId || null, nota: texto }, ip: getClientIp(c),
  });

  return c.json({ ok: true, data: { id: notaId } }, 201);
});
