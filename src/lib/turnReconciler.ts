import { and, asc, eq } from "drizzle-orm";
import * as schema from "../db/schema";
import { dinero, type Cajas } from "./cierreDinero";

// ─── EL RECONCILIADOR DE LA CADENA (F6) ──────────────────────────────────────
//
// La cadena de una caja es una lista de fotos por hora de negocio:
//
//   apertura → cierre → apertura → cierre → apertura …
//
// Cada foto se compara contra su vecina INMEDIATA anterior DE LA MISMA CAJA. No
// contra la primera, y no contra la del cajero anterior: es la foto anterior, la
// que sea.
//
// ESA es la razón por la que un eslabón que falta no rompe la cadena: solo difiere
// SU comparación entrante. Si closeA1 sigue en la cola, la comparación de openB1
// queda pendiente, pero closeB1 vs openB1 y openB2 vs closeB1 se hacen igual.
//
// Dos fotos siempre están comparables si existen, porque cada una guarda la hora a
// la que se CONTÓ. Una foto que llega tres días tarde cierra el periodo del día en
// que se contó, no el día que llegó — por eso `periodEnd = countedAt` en /confirm.
//
// Y lo que compara NO vuelve a ajustar el stock. El ajuste lo hizo la foto al
// llegar, con la regla de aplicación (F0): si su hora es anterior a la última foto,
// la venta ya venía dentro del número contado y no se aplicó. Aquí solo se DETECTA
// y se anota.

export type TipoFoto = "apertura" | "cierre";

export interface Foto {
  tipo: TipoFoto;
  id: string;
  /** Hora a la que se contó, no a la que llegó. */
  at: Date;
  /** Conteo por producto. */
  items: any[];
  origen?: string;
}

export interface Diferencias {
  items: Record<string, number>;
  cash: Cajas;
}

/** Todas las fotos de una caja, en orden de hora de negocio. */
export async function fotosDeLaCaja(db: any, companyId: string, locationId: string): Promise<Foto[]> {
  const [lecturas, cierres] = await Promise.all([
    db.select().from(schema.inventoryReadings)
      .where(and(
        eq(schema.inventoryReadings.companyId, companyId),
        eq(schema.inventoryReadings.locationId, locationId),
        eq(schema.inventoryReadings.type, "apertura"),
      )).all(),
    db.select().from(schema.cashClosings)
      .where(and(
        eq(schema.cashClosings.companyId, companyId),
        eq(schema.cashClosings.locationId, locationId),
      )).all(),
  ]);

  return [
    ...(lecturas as any[]).map((x) => ({
      tipo: "apertura" as const, id: x.id,
      at: new Date(x.createdAt ?? 0), items: (x.items ?? []) as any[], origen: x.origen,
    })),
    ...(cierres as any[]).map((x) => ({
      tipo: "cierre" as const, id: x.id,
      at: new Date(x.countedAt ?? x.createdAt ?? 0), items: (x.items ?? []) as any[], origen: "contado",
    })),
  ].sort((a, b) => a.at.getTime() - b.at.getTime());
}

/** La última foto de una caja: sirve de base para el esperado de la siguiente. */
export async function ultimaFoto(db: any, companyId: string, locationId: string): Promise<Foto | null> {
  const fotos = await fotosDeLaCaja(db, companyId, locationId);
  return fotos.length ? fotos[fotos.length - 1] : null;
}

/**
 * El esperado para una foto, según lo que dejó la foto anterior.
 *
 *   apertura → lo que había − lo que se retiró de la caja en medio
 *   cierre   → lo que había + ventas del periodo − retiros
 *
 * El dinero se lleva por moneda y nunca sumando entre monedas. En una apertura NO
 * hay ventas: se empieza a vender después de contar. Lo que puede haber es dinero
 * que salió a la caja fuerte, y eso es lo que separa una apertura de un turno
 * anterior: 1 000 en caja, el admin retira 800, la apertura cuenta 200 y cuadra.
 */
export async function esperadoDesdeFotoAnterior(
  db: any,
  companyId: string,
  locationId: string,
  prev: Foto,
  next: Foto,
): Promise<Diferencias> {
  const nextAt = next.at;
  // ── Mercancía: lo que había en cada producto al cerrar la foto anterior ──
  const prevPorProducto = new Map<string, number>();
  for (const it of prev.items || []) {
    const pid = it?.productId;
    if (!pid) continue;
    // Una apertura guarda `contado`; un cierre guarda `stockValidated`. Se leen
    // los dos porque son las dos formas que tiene una foto de decir "había esto".
    const q = it.contado !== undefined ? Number(it.contado) : Number(it.stockValidated ?? 0);
    if (Number.isFinite(q)) prevPorProducto.set(String(pid), q);
  }

  // ── Dinero: movimientos APROBADOS entre ambas fotos ──
  // Los pendientes no cuentan: hasta que un admin no aprueba el retiro, el dinero
  // no salió de la caja todavía, y contarlo haría saltar un descuadre que no existe.
  const movs = await db.select().from(schema.cashMovements)
    .where(and(
      eq(schema.cashMovements.companyId, companyId),
      eq(schema.cashMovements.locationId, locationId),
      eq(schema.cashMovements.status, "aprobada"),
    )).all();

  const desde = prev.at.getTime();
  const hasta = nextAt.getTime();
  const entradas: Cajas = {};
  const salidas: Cajas = {};
  const ventasPorMoneda = new Map<string, number>();

  for (const m of movs as any[]) {
    const t = new Date(m.businessAt ?? m.createdAt ?? 0).getTime();
    if (t <= desde || t > hasta) continue;
    const destino = m.type === "entrada" ? entradas : salidas;
    destino[m.currency] = Math.round(((destino[m.currency] || 0) + Number(m.amount)) * 100) / 100;
  }

  // ── Esperado de cada foto ──
  const items: Record<string, number> = {};

  if (next.tipo === "apertura") {
    // Solo restan los retiros: aún no se ha vendido nada en este turno.
    for (const [k, v] of Object.entries(salidas)) {
      const base = (entradas[k] || 0) - v;
      if (Math.abs(base) > 0.005) items[k] = base;
    }
  } else {
    // Cierre: entra lo vendido en efectivo durante el periodo.
    const ventas = await db.select().from(schema.sales)
      .where(and(
        eq(schema.sales.companyId, companyId),
        eq(schema.sales.locationId, locationId),
        eq(schema.sales.status, "emitida"),
      )).all();
    for (const v of ventas as any[]) {
      const t = new Date(v.createdAt ?? 0).getTime();
      if (t <= desde || t > hasta) continue;
      if (v.payMethod !== "efectivo") continue;
      const cur = (v.currency || "CUP").toUpperCase();
      ventasPorMoneda.set(cur, Math.round(((ventasPorMoneda.get(cur) || 0) + Number(v.total)) * 100) / 100);
    }
  }

  // ── Diferencias contra lo contado ──
  const contadoItems: Record<string, number> = {};
  for (const it of next.items || []) {
    const pid = it?.productId;
    if (!pid) continue;
    const q = it.contado !== undefined ? Number(it.contado) : Number(it.stockValidated ?? 0);
    if (Number.isFinite(q)) contadoItems[String(pid)] = q;
  }

  for (const [pid, esperado] of Object.entries(items)) {
    const d = Math.round(((contadoItems[pid] ?? 0) - esperado) * 1000) / 1000;
    if (Math.abs(d) > 0.001) items[pid] = d;
  }
  for (const [pid, contado] of Object.entries(contadoItems)) {
    if (pid in items) continue;
    const base = prevPorProducto.get(pid) ?? 0;
    const d = Math.round((contado - base) * 1000) / 1000;
    if (Math.abs(d) > 0.001) items[pid] = d;
  }

  // ── Dinero ──
  const baseDinero: Cajas = {};
  for (const it of prev.items || []) {
    // El dinero que la foto anterior registró.
    const c = it?.cashCounted;
    if (c && typeof c === "object") {
      for (const [k, v] of Object.entries(dinero(c))) baseDinero[k] = (baseDinero[k] || 0) + v;
    }
  }

  const cash: Cajas = {};
  const esperadoDinero: Cajas = { ...baseDinero };
  if (next.tipo === "cierre") {
    for (const [k, v] of ventasPorMoneda) esperadoDinero[k] = (esperadoDinero[k] || 0) + v;
  }
  for (const [k, v] of Object.entries(entradas)) esperadoDinero[k] = (esperadoDinero[k] || 0) + v;
  for (const [k, v] of Object.entries(salidas)) esperadoDinero[k] = (esperadoDinero[k] || 0) - v;

  const contadoDinero: Cajas = {};
  for (const it of next.items || []) {
    const c = it?.cashCounted;
    if (c && typeof c === "object") {
      for (const [k, v] of Object.entries(dinero(c))) contadoDinero[k] = (contadoDinero[k] || 0) + v;
    }
  }
  for (const k of new Set([...Object.keys(esperadoDinero), ...Object.keys(contadoDinero)])) {
    const d = Math.round(((contadoDinero[k] || 0) - (esperadoDinero[k] || 0)) * 100) / 100;
    if (Math.abs(d) > 0.005) cash[k] = d;
  }

  return { items, cash };
}

export interface Resultado {
  compared: number;
  pending: number;
  different: number;
}

/**
 * Revisa la cadena de una caja y resuelve las comparaciones pendientes.
 *
 * NO ajusta stock: la foto ya lo ajustó al llegar. Esto solo anota qué pasó
 * entre dos fotos consecutivas, para que el turno siguiente no cargue con un
 * descuadre del anterior.
 */
export async function reconciliarCaja(db: any, companyId: string, locationId: string): Promise<Resultado> {
  const r: Resultado = { compared: 0, pending: 0, different: 0 };

  const fotos = await fotosDeLaCaja(db, companyId, locationId);
  if (fotos.length < 2) return r;

  const yaHechas = new Set<string>();
  const existentes = await db.select().from(schema.turnReconciliations)
    .where(and(
      eq(schema.turnReconciliations.companyId, companyId),
      eq(schema.turnReconciliations.locationId, locationId),
    )).all();
  for (const e of existentes as any[]) {
    yaHechas.add(`${e.locationId}|${e.prevType}|${e.prevId}|${e.nextType}|${e.nextId}`);
  }

  for (let i = 1; i < fotos.length; i++) {
    const prev = fotos[i - 1];
    const next = fotos[i];
    const clave = `${locationId}|${prev.tipo}|${prev.id}|${next.tipo}|${next.id}`;
    if (yaHechas.has(clave)) continue;

    const { items, cash } = await esperadoDesdeFotoAnterior(db, companyId, locationId, prev, next);
    const hayAlgo = Object.keys(items).length > 0 || Object.keys(cash).length > 0;
    const estado = hayAlgo ? "diferente" : "conciliado";
    if (hayAlgo) r.different++; else r.compared++;

    await db.insert(schema.turnReconciliations).values({
      id: cryptoRandomUUID(),
      companyId, locationId,
      prevType: prev.tipo, prevId: prev.id,
      nextType: next.tipo, nextId: next.id,
      status: estado,
      diffItems: items,
      diffCash: cash,
      prevAt: prev.at,
      nextAt: next.at,
      reconciledAt: new Date(),
    }).run().catch(() => { /* duplicado en carrera: otro intento ya lo escribió */ });
  }

  return r;
}

/** Reconcilia todas las cajas de la empresa. Es lo que llama el sincronizador. */
export async function reconciliarEmpresa(db: any, companyId?: string): Promise<Resultado> {
  const locs = companyId
    ? await db.select({ id: schema.inventoryLocations.id }).from(schema.inventoryLocations)
        .where(eq(schema.inventoryLocations.companyId, companyId)).all()
    : await db.select({ id: schema.inventoryLocations.id }).from(schema.inventoryLocations).all();

  const total: Resultado = { compared: 0, pending: 0, different: 0 };
  for (const l of locs as any[]) {
    const r = await reconciliarCaja(db, String(l.companyId || ""), l.id).catch(
      () => ({ compared: 0, pending: 0, different: 0 } as Resultado),
    );
    total.compared += r.compared;
    total.pending += r.pending;
    total.different += r.different;
  }
  return total;
}

function cryptoRandomUUID(): string {
  return (globalThis.crypto as any)?.randomUUID?.()
    ?? "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (ch) => {
      const r = (Math.random() * 16) | 0;
      const v = ch === "x" ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
}