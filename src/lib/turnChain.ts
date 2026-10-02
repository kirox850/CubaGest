import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { getLocationStockQty } from "./locations";
import {
  ensureLocationStockStmt, incrementStockStmt, decrementStockStmt,
  recomputeProductStockStmt, stockMovementStmt,
} from "./batch";

// ─── REGLA DE APLICACIÓN DE STOCK (plan de cadena de turnos, F0) ──────────────
//
// El stock dejó de ser un número que se va sumando. Cada lectura y cada cierre
// registran LA CANTIDAD CONTADA en un instante, y el stock es ese número más lo
// que pase después. Eso hace falta porque, si no, una venta que llega tarde
// descuenta dos veces lo mismo:
//
//   7:55  se venden 10 unidades, sin señal
//   8:00  el cajero cuenta: ya no están. Faltan 10 → el stock baja 10   ✓ correcto
//   9:00  llega la venta y descuenta 10 otra vez                   ✗ stock bajo de más
//
// Al llegar tarde, esa venta ya está DENTRO del número contado. Por eso no se
// aplica al stock otra vez. Sigue registrándose como venta: entra en
// facturación, en contabilidad y en el historial. Lo único que no hace es volver
// a mover la caja.
//
// ESTA ES LA REGLA:
//
//   hora de negocio > última foto de la caja  →  se aplica normal
//   hora de negocio ≤ última foto de la caja  →  NO se toca el stock
//
// "Foto" es una lectura de apertura o un cierre, y lleva la hora a la que se
// CONTÓ, no la que llegó al servidor. Sin esa distinción el caso offline se
// rompe: un cierre subido tres días después fecha su período el día de la
// lectura, y arrastra las ventas de esos tres días.
//
// Si una caja nunca se ha contado (`lastSnapshotAt` es NULL) se aplica todo:
// no hay foto contra la cual comparar, que es el comportamiento de siempre.

export interface AplicacionStock {
  /** Si el movimiento debe alterar el stock. */
  aplica: boolean;
  /** Por qué no, cuando no aplica. Se guarda para poder explicarlo después. */
  motivo?: string;
  /** Hora de la última foto, si la hay. */
  ultimaFoto: Date | null;
}

/**
 * Decide si un movimiento debe tocar el stock, según su hora de negocio.
 *
 * @param db          drizzle
 * @param locationId  la caja
 * @param negocioEn   hora a la que ocurrió el movimiento (la del POS, no la de
 *                    llegada). Si no se sabe, se usa ahora.
 */
export async function debeAplicarAlStock(
  db: any,
  locationId: string,
  negocioEn: Date,
): Promise<AplicacionStock> {
  const loc = await db.select({ lastSnapshotAt: schema.inventoryLocations.lastSnapshotAt })
    .from(schema.inventoryLocations)
    .where(eq(schema.inventoryLocations.id, locationId))
    .get();

  const ultimaFoto = loc?.lastSnapshotAt ?? null;
  // Sin foto previa no hay contra qué comparar: se aplica, como siempre.
  if (!ultimaFoto) return { aplica: true, ultimaFoto: null };

  const t = negocioEn instanceof Date ? negocioEn : new Date(negocioEn);
  // `<=` y no `<`: una venta a la misma hora exacta que el conteo ya está dentro
  // del número contado. Contar de más sería el error que rompe la cadena.
  if (t.getTime() <= ultimaFoto.getTime()) {
    return {
      aplica: false,
      ultimaFoto,
      motivo: `Su hora (${t.toISOString()}) es anterior o igual a la última foto de esta caja (${ultimaFoto.toISOString()}): ya está dentro del número contado.`,
    };
  }
  return { aplica: true, ultimaFoto };
}

/** Marca una caja como recién contada. Se llama al registrar una foto. */
export async function marcarFoto(db: any, locationId: string, contadoEn: Date): Promise<void> {
  await db.update(schema.inventoryLocations)
    .set({ lastSnapshotAt: contadoEn })
    .where(eq(schema.inventoryLocations.id, locationId));
}

/**
 * ¿Debe este movimiento tocar el stock?
 *
 * Variante que no lanza: si no se puede comprobar (tabla sin la columna, base en
 * un estado raro), devuelve `true`. Ante la duda se aplica el movimiento: es el
 * comportamiento histórico, y saltárselo por un error de base dejaría el stock
 * desincronizado en silencio, que es peor que un descuadre visible.
 */
export async function aplicaAlStock(db: any, locationId: string, negocioEn: Date): Promise<boolean> {
  try {
    return (await debeAplicarAlStock(db, locationId, negocioEn)).aplica;
  } catch {
    return true;
  }
}

// ─── FOTOS DE LA CADENA (F3) ─────────────────────────────────────────────────
//
// Una "foto" es un conteo físico con su hora: una lectura de apertura o un
// cierre. El stock es la última foto más lo que pasó después, así que registrar
// una foto es también marcar hasta dónde llega esa verdad.
//
// Lo que guarda cada foto, además de las cantidades:
//   origen  "contado"  → alguien contó
//           "heredado" → se copió de la foto anterior (ajuste 2 del plan)
//   stockInicialPorProducto → lo que decía el stock ANTES del conteo, para poder
//           mostrar "esperado vs contado" y para saber qué cambió el ajuste.
//
// El ajuste al stock se calcula por producto: `contado − stockPrevio`. Positivo es
// sobrante, negativo es faltante. Se aplica de golpe al confirmar la foto.

export interface FotoItem {
  productId: string;
  productCode?: string;
  productName?: string;
  unit?: string;
  /** Lo que había en el stock del sistema antes de contar. */
  stockPrevio: number;
  /** Lo que contó la persona. */
  contado: number;
}

/** Ajuste por producto: `contado − stockPrevio`. Positivo sobra, negativo falta. */
export function deltaPorProducto(items: FotoItem[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const it of items) {
    const d = Math.round((Number(it.contado) - Number(it.stockPrevio)) * 1000) / 1000;
    if (Math.abs(d) > 0.0005) out[it.productId] = d;
  }
  return out;
}

/**
 * El ajuste total por producto de una foto, o `null` si no hay nada que ajustar.
 * Se agrupa por producto para no aplicar tres veces el mismo movimiento cuando
 * varios productos comparten la misma fila.
 */
export function resumenDelta(items: FotoItem[]) {
  const deltas = deltaPorProducto(items);
  const nombres = new Map<string, { code: string; name: string; unit: string }>();
  for (const it of items) {
    if (!nombres.has(it.productId)) {
      nombres.set(it.productId, {
        code: String(it.productCode ?? ""),
        name: String(it.productName ?? ""),
        unit: String(it.unit ?? ""),
      });
    }
  }
  return { deltas, nombres };
}

/** ¿El negocio configuró que la apertura herede el cierre anterior? */
export async function aperturaHeredada(db: any, companyId: string): Promise<boolean> {
  const s: any = await db.select().from(schema.companySettings)
    .where(eq(schema.companySettings.companyId, companyId)).get();
  return s?.openingInheritsPrevious === true;
}

// ─── LA FOTO DE APERTURA, EN UN SOLO SITIO ───────────────────────────────────
//
// Hasta ahora había TRES puertas que creaban una foto de apertura y cada una lo
// hacía a su manera: /closing/readings contaba, /shift/start copiaba el stock a
// ciegas, y el cierre generaba la suya sin guardar el dinero. La app abre turno
// por /shift/start, así que el conteo real nunca se veía.
//
// Ahora hay una sola función y las tres la usan. Devuelve PREPARED STATEMENTS y
// no ejecuta nada: el llamante mete todo en su lote, para que la foto y el turno
// se guarden o no se guarden nunca, nunca a medias.

export interface ArgsFotoApertura {
  readingId: string;
  companyId: string;
  locationId: string;
  userId: string;
  notas?: string | null;
  /** Conteo por producto. Si viene vacío, la foto ES el stock actual. */
  items?: { productId: string; contado: number }[];
  /** Hora a la que se CUENTA. Es lo que fija hasta dónde llega la foto. */
  negocioEn: Date;
}

/**
 * Prepara la escritura completa de una foto de apertura:
 * la lectura, el ajuste por diferencia y la marca de "última foto" de la caja.
 */
export async function stmtsFotoApertura(DB: D1Database, args: ArgsFotoApertura): Promise<D1PreparedStatement[]> {
  const { readingId, companyId, locationId, userId, negocioEn } = args;
  const db = drizzle(DB, { schema });

  // El ajuste 2 del plan: con él activo, la apertura copia la foto anterior en
  // lugar de contar. Apagado por defecto — no verificar la caja en el cambio de
  // turno hace que el error aflore en el cierre siguiente, atribuido a otro cajero.
  const hereda = await aperturaHeredada(db, companyId);

  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, companyId), eq(schema.products.active, true))).all();

  const stockPrevio = new Map<string, number>();
  for (const p of products) stockPrevio.set(p.id, await getLocationStockQty(db, locationId, p.id));

  const enviados = new Map<string, number>();
  for (const it of args.items || []) {
    const n = Number(it?.contado);
    if (it?.productId && Number.isFinite(n) && n >= 0) enviados.set(String(it.productId), n);
  }

  const items: FotoItem[] = [];
  for (const p of products) {
    const previo = stockPrevio.get(p.id) ?? 0;
    // Heredado: la copia es el stock. Sin conteo explícito: la foto ES el stock,
    // que es lo que pasaba con esta pantalla antes de que existiera el conteo.
    const contado = hereda ? previo : (enviados.get(String(p.id)) ?? previo);
    items.push({
      productId: p.id, productCode: p.code, productName: p.name, unit: p.unit,
      stockPrevio: previo, contado,
    });
  }

  const { deltas } = resumenDelta(items);
  const stmts: D1PreparedStatement[] = [
    DB.prepare(
      `INSERT INTO inventory_readings (id, company_id, location_id, taken_by_id, type, notes, items, origen, is_opening, created_at)
       VALUES (?, ?, ?, ?, 'apertura', ?, ?, ?, 1, ?)`
    ).bind(
      readingId, companyId, locationId, userId, args.notas || null,
      JSON.stringify(items), hereda ? "heredado" : "contado",
      Math.floor(negocioEn.getTime() / 1000)
    ),
  ];

  for (const [productId, deltaRaw] of Object.entries(deltas)) {
    const delta = Number(deltaRaw);
    stmts.push(ensureLocationStockStmt(DB, locationId, productId));
    stmts.push(
      delta > 0
        ? incrementStockStmt(DB, locationId, productId, delta)
        : decrementStockStmt(DB, locationId, productId, -delta)
    );
    stmts.push(
      stockMovementStmt(DB, {
        companyId, productId, userId, locationId,
        type: "ajuste", qty: delta, reason: "Conteo de apertura",
      })
    );
    stmts.push(recomputeProductStockStmt(DB, productId));
  }

  // A partir de esta hora, lo que llegue con hora anterior ya está dentro de lo
  // contado y no debe volver a aplicarse al stock.
  stmts.push(
    DB.prepare(`UPDATE inventory_locations SET last_snapshot_at = ? WHERE id = ?`)
      .bind(Math.floor(negocioEn.getTime() / 1000), locationId)
  );

  return stmts;
}
