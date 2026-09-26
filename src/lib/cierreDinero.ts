import { eq, and, gte, lte } from "drizzle-orm";
import * as schema from "../db/schema";

// ─── CONCILIACIÓN DE DINERO ─────────────────────────────────────────────────
//
// El cierre antes solo miraba inventario. El dinero se registraba pero nunca se
// contaba, así que un faltante de 300 pesos en la caja no era detectable: el
// dueño se enteraba semanas después, cuando ya no había nada que hacer.
//
// Aquí la cuenta, por moneda:
//
//   esperado = base del turno + ventas en efectivo + entradas − salidas
//   descuadre = contado − esperado
//
// Y hay dos detalles que parecen detalles y no lo son:
//
// 1. Cada moneda se lleva por separado. Si en la caja hay 100 CUP y 2 USD, se
//    compara 100 contra los CUP esperados y 2 contra los USD esperados. Sumar
//    "102" contra un total en CUP no significa nada.
//
// 2. Solo se cuentan las ventas EN EFECTIVO. Una venta pagada por transferencia
//    no entra en la caja, así que sumarla sería esperar dinero que llegó por
//    otro camino y marcar un faltante que no existe.

export type Cajas = Record<string, number>;

export const dinero = (v: unknown): Cajas => {
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Cajas = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    const n = Number(val);
    if (Number.isFinite(n) && Math.abs(n) > 0.0000001) out[k] = parseFloat(n.toFixed(2));
  }
  return out;
};

const sumar = (a: Cajas, b: Cajas, signo: 1 | -1) => {
  const out: Cajas = { ...a };
  for (const [k, v] of Object.entries(b)) {
    const n = (out[k] || 0) + signo * v;
    if (Math.abs(n) > 0.0000001) out[k] = parseFloat(n.toFixed(2));
    else delete out[k];
  }
  return out;
};

export const restar = (a: Cajas, b: Cajas) => sumar(a, b, -1);

/** Redondea a 2 decimales: el dinero no tiene más precisión que el centavo. */
const r2 = (n: number) => parseFloat(n.toFixed(2));

/**
 * ¿Esta diferencia se explica con la diferencia de la caja?
 *
 * La regla acordada es EXACTA: una explicación de 300 no resuelve un faltante
 * de 297 ni uno de 305. Se muestra como candidato —que ayuda a entender qué
 * pasó— pero no cierra nada. Aceptar importes aproximados sería dejar que
 * cualquier descuadre se declare resuelto con un número redondo, que es
 * exactamente lo que un cierre de caja tiene que evitar.
 */
export const explicaExactamente = (diff: number, explicacion: number) =>
  Math.abs(Math.abs(diff) - Math.abs(explicacion)) < 0.005;

/** El margen del negocio: por debajo de esto, la diferencia es ruido conocido. */
export function dentroDelMargen(diff: number, mode: string, valor: number, esperado: number) {
  if (!Number.isFinite(valor) || valor <= 0) return false;
  const limite = mode === "porcentaje" ? (Math.abs(esperado) * valor) / 100 : valor;
  return Math.abs(diff) <= limite;
}

export type Conciliacion = {
  base: Cajas;
  ventas: Cajas;
  entradas: Cajas;
  salidas: Cajas;
  esperado: Cajas;
  contado: Cajas;
  diff: Cajas;
  descuadra: boolean;
};

/**
 * Calcula la conciliación completa del turno.
 *
 * @param countedCash lo que el cajero contó, por moneda
 * @param baseCash     el fondo con el que abrió el turno
 * @param locationId   la caja, para traer sus ventas y movimientos
 */
export async function conciliar(
  db: any,
  companyId: string,
  locationId: string,
  opts: {
    periodStart: Date;
    periodEnd: Date;
    baseCash: Cajas;
    countedCash: Cajas;
    shiftId?: string | null;
    /** Los días de la venta, no los de la llegada: una venta de ayer que
     *  entró hoy cuenta para el turno que estaba abierto ayer. */
    fechaOverride?: Date | null;
  },
): Promise<Conciliacion> {
  const { periodStart, periodEnd, baseCash, countedCash } = opts;
  const fechaVenta = opts.fechaOverride ?? new Date();

  // ── Ventas en efectivo ──
  const ventas = await db.select().from(schema.sales)
    .where(and(
      eq(schema.sales.companyId, companyId),
      eq(schema.sales.locationId, locationId),
      eq(schema.sales.status, "emitida"),
      gte(schema.sales.createdAt, periodStart),
      lte(schema.sales.createdAt, periodEnd),
    )).all();

  const ventasCash: Cajas = {};
  for (const v of ventas) {
    // Las ventas de OTRA moneda no entran en la caja de esa moneda: cada una
    // va a la suya. Y solo el efectivo pasa por la caja.
    if (v.payMethod !== "efectivo") continue;
    const cur = (v as any).currency || "CUP";
    ventasCash[cur] = r2((ventasCash[cur] || 0) + Number(v.total));
  }

  // ── Entradas y salidas YA APROBADAS ──
  // Las pendientes no cuentan: hasta que un admin no las aprueba, el dinero
  // no está en la caja todavía, y contarlas haría que el cierre de un cajero se
  // descuadrado por un retiro que nadie ha autorizado todavía.
  const movs = await db.select().from(schema.cashMovements)
    .where(and(
      eq(schema.cashMovements.companyId, companyId),
      eq(schema.cashMovements.locationId, locationId),
      eq(schema.cashMovements.status, "aprobada"),
    )).all();

  const desde = periodStart.getTime();
  const hasta = periodEnd.getTime();
  const entradas: Cajas = {};
  const salidas: Cajas = {};
  for (const m of movs) {
    const t = new Date(m.createdAt).getTime();
    if (opts.shiftId) {
      // Con turno: solo los movimientos de ESTE turno. Es lo que hace que
      // dos turnos sobre la misma caja no se pisen entre sí.
      if (m.shiftId !== opts.shiftId) continue;
    } else {
      if (t < desde || t > hasta) continue;
    }
    const destino = m.type === "entrada" ? entradas : salidas;
    destino[m.currency] = r2((destino[m.currency] || 0) + Number(m.amount));
  }

  // ── La cuenta ──
  let esperado = { ...baseCash };
  for (const [k, v] of Object.entries(ventasCash)) esperado[k] = r2((esperado[k] || 0) + v);
  for (const [k, v] of Object.entries(entradas)) esperado[k] = r2((esperado[k] || 0) + v);
  for (const [k, v] of Object.entries(salidas)) esperado[k] = r2((esperado[k] || 0) - v);

  const esperadoLimpio: Cajas = {};
  for (const [k, v] of Object.entries(esperado)) {
    if (Math.abs(v) > 0.0000001) esperadoLimpio[k] = v;
  }

  const diff: Cajas = {};
  const monedas = new Set([...Object.keys(esperadoLimpio), ...Object.keys(countedCash)]);
  for (const k of monedas) {
    const d = r2((countedCash[k] || 0) - (esperadoLimpio[k] || 0));
    if (Math.abs(d) > 0.005) diff[k] = d;
  }

  return {
    base: baseCash, ventas: ventasCash, entradas, salidas,
    esperado: esperadoLimpio, contado: countedCash, diff,
    descuadra: Object.keys(diff).length > 0,
  };
}

/**
 * ¿Está ya explicado este descuadre?
 *
 * Todas las monedas tienen que estar resueltas para que el cierre pase a
 * "resuelto": un cierre no está a medio explicar. Las explicaciones
 * aproximadas no cuentan, pero se devuelven aparte para poder mostrarlas.
 */
export async function estadoExplicaciones(
  db: any,
  closingId: string,
  diff: Cajas,
): Promise<{ pendientes: string[]; exactas: Record<string, any[]> }> {
  const rows = await db.select().from(schema.closingExplanations)
    .where(eq(schema.closingExplanations.closingId, closingId)).all();

  const exactas: Record<string, any[]> = {};
  for (const k of Object.keys(diff)) exactas[k] = [];
  const pendientes: string[] = [];

  for (const k of Object.keys(diff)) {
    const d = diff[k];
    const mias = rows.filter((r: any) => r.currency === k);
    // Se acumula lo explicado y se compara contra la diferencia COMPLETA:
    // dos explicaciones de 100 resuelven un faltante de 200, una de 100 y otra
    // de 50 no resuelven uno de 200 porque sobra una parte.
    let explicado = 0;
    for (const e of mias) {
      explicado = r2(explicado + Math.abs(Number(e.amount)));
      if (explicaExactamente(d, explicado)) {
        (exactas[k] ||= []).push(e);
      }
    }
    if (!exactas[k] || exactas[k].length === 0) {
      // Aun así, se guarda lo que más se le acerca, para que la pantalla
      // pueda decir "te faltó esto por poco" en vez de dejarlo en blanco.
      const mejor = mias.slice().sort((a: any, b: any) =>
        Math.abs(Math.abs(Number(a.amount)) - Math.abs(d)) - Math.abs(Math.abs(Number(b.amount)) - Math.abs(d)))[0];
      pendientes.push(k);
      if (mejor) (exactas[k] ||= []).push(mejor);
    }
  }
  return { pendientes, exactas };
}

export const VENTANA_PROVISIONAL_HORAS = 20;

/** Cuándo vence la ventana, contada desde la HORA DEL CONTEO. */
export function venceProvisional(countedAt: Date | Date | null, ahora: Date) {
  const base = countedAt || ahora;
  return new Date(base.getTime() + VENTANA_PROVISIONAL_HORAS * 3_600_000);
}
