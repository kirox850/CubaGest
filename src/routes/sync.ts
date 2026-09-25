import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";
import { getClientIp } from "../lib/audit";
import { resolveSaleLocation, createSale, validateClientSaleId, MAX_SYNC_BATCH, type SaleLineInput } from "../lib/sales";
import { resolveOwnLocation } from "../lib/locations";

const sync = new Hono<{ Bindings: Env }>();

sync.use("*", authMiddleware);

interface SyncSale {
  // Identificador de la venta en el dispositivo. OBLIGATORIO: es lo que hace
  // idempotente el reenvío (si la respuesta anterior se perdió, el cliente
  // reintenta y recibe la MISMA factura, no una nueva).
  clientSaleId?: string;
  // Identificador local heredado del cliente viejo; solo se devuelve como eco.
  localId?: string;
  clientName?: string;
  clientNit?: string;
  clientPhone?: string;
  currency?: string;
  payMethod?: string;
  // Solo admin puede elegir ubicación; para el resto manda la suya.
  locationId?: string;
  items?: SaleLineInput[];
  discountId?: string;
  offlineTimestamp?: number;
}

// POST /sales/sync
// Recibe ventas generadas offline y devuelve UN RESULTADO POR CADA venta
// enviada. Cada venta se procesa sola y atómicamente: una venta mal formada o
// sin stock no puede dejar nada a medias ni tirar abajo las demás del lote.
// Los resultados se emiten en el orden CRONOLÓGICO en que se procesan (el
// stock de un lote depende del orden: si dos ventas compiten por el mismo
// producto, la primera es la que se guarda). El resultado lleva SIEMPRE el
// clientSaleId y el localId de entrada, así que el cliente empareja por id y
// no por posición.
sync.post("/", requireModule("pos"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ sales?: SyncSale[]; locationId?: string }>().catch(() => ({}) as { sales?: SyncSale[] });

  const inputSales = body.sales;
  if (!Array.isArray(inputSales) || inputSales.length === 0) {
    return c.json({ ok: false, error: "No hay ventas para sincronizar" }, 400);
  }
  if (inputSales.length > MAX_SYNC_BATCH) {
    return c.json(
      { ok: false, error: `Máximo ${MAX_SYNC_BATCH} ventas por sincronización. Divida la cola en varios envíos.`, code: "BATCH_TOO_LARGE" },
      400
    );
  }

  const results: Record<string, unknown>[] = [];
  // Ventas ya aceptadas de ESTE lote: el contador mensual del plan todavía no
  // las ve (cada venta se confirma por separado), así que se las pasamos para
  // que el lote no se pase del tope del plan.
  let acceptedInBatch = 0;

  // Ubicación por venta, NO una para todo el lote: una cola puede contener
  // ventas de dos ubicaciones (el admin que vendió en el almacén y en una caja,
  // o un cajero al que le movieron la caja). Fijar una sola ubicación del lote
  // guardaría unas ventas en la caja equivocada y su stock se descontaría de
  // donde no estaba. Para cajero/almacenista la resolución es siempre la misma
  // (su propia ubicación), así que se resuelve una vez y se reutiliza.
  const batchLocationId = body.locationId ?? null;
  let cachedOwnLocation: string | undefined;
  async function locationForSale(raw: SyncSale): Promise<
    { ok: true; id: string } | { ok: false; error: string; code: string; status: number }
  > {
    if (auth.role !== "admin") {
      if (cachedOwnLocation === undefined) {
        const own = await resolveOwnLocation(db, auth);
        cachedOwnLocation = own?.id ?? "";
      }
      if (!cachedOwnLocation) {
        return {
          ok: false,
          status: 400,
          code: "LOCATION_MISSING",
          error: "No tiene una ubicación de venta asignada. Contacte al administrador.",
        };
      }
      return { ok: true, id: cachedOwnLocation };
    }
    const requested = raw?.locationId ?? batchLocationId ?? null;
    const res = await resolveSaleLocation(db, auth, requested);
    if (!res.ok) return { ok: false, error: res.error, code: res.code ?? "LOCATION_INVALID", status: res.status };
    return { ok: true, id: res.location.id };
  }

  // Orden cronológico de lo que el cajero hizo offline (solo para procesar en
  // el mismo orden; la FECHA DE LA VENTA es la del servidor, ver abajo).
  const sorted = [...inputSales].sort(
    (a, b) => (a?.offlineTimestamp || 0) - (b?.offlineTimestamp || 0)
  );

  for (const saleData of sorted) {
    const raw = saleData as SyncSale | undefined;
    const localId = raw?.localId ?? null;
    const clientIdCheck = validateClientSaleId(raw?.clientSaleId);

    if (!raw || typeof raw !== "object") {
      results.push({ localId, clientSaleId: null, status: "conflict", reason: "Venta mal formada", retryable: false });
      continue;
    }
    if (!clientIdCheck.ok || !clientIdCheck.value) {
      results.push({
        localId,
        clientSaleId: raw.clientSaleId ?? null,
        status: "conflict",
        reason: clientIdCheck.ok
          ? "clientSaleId es requerido para sincronizar"
          : clientIdCheck.error,
        code: "CLIENT_SALE_ID_REQUIRED",
        retryable: false,
      });
      continue;
    }
    const clientSaleId = clientIdCheck.value;

    // Cada venta se procesa por separado: un error aquí NO toca el estado de
    // las demás, y esta venta no deja ventas/líneas/stock a medias.
    const loc = await locationForSale(raw);
    if (!loc.ok) {
      results.push({
        localId,
        clientSaleId,
        status: "conflict",
        reason: loc.error,
        code: loc.code,
        retryable: false,
      });
      continue;
    }

    const result = await createSale(c.env, db, auth, {
      clientSaleId,
      clientName: raw.clientName,
      clientNit: raw.clientNit,
      clientPhone: raw.clientPhone,
      currency: raw.currency,
      payMethod: (raw.payMethod ?? "") as string,
      locationId: loc.id,
      items: Array.isArray(raw.items) ? (raw.items as SaleLineInput[]) : [],
      discountId: raw.discountId ?? null,
      offlineTimestamp: typeof raw.offlineTimestamp === "number" ? raw.offlineTimestamp : null,
      synced: true,
      alreadyInBatch: acceptedInBatch,
      ip: getClientIp(c),
    });

    if (result.ok) {
      // "synced" también para los reintentos: quien ya había sincronizado esta
      // venta (duplicate=true) recibe su MISMA factura y no debe duplicar nada
      // en su cola local. Solo una venta NUEVA cuenta para el límite del lote.
      if (!result.duplicate) acceptedInBatch++;
      results.push({
        localId,
        clientSaleId,
        status: "synced",
        serverId: result.sale.id,
        invoiceNumber: result.sale.invoiceNumber,
        date: result.sale.date,
        total: Number(result.sale.total),
        currency: result.sale.currency,
        locationId: result.sale.locationId,
        duplicate: result.duplicate,
      });
    } else {
      // Fallo de ESTA venta. `retryable` distingue "reintenta igual" (fallo
      // puntual del servidor) de "corrija los datos" (validación/stock).
      results.push({
        localId,
        clientSaleId,
        status: "conflict",
        reason: result.error,
        code: result.code ?? "SALE_REJECTED",
        retryable: result.retryable === true,
      });
    }
  }

  const synced = results.filter((r) => r.status === "synced").length;
  return c.json({ ok: true, data: results, summary: { total: results.length, synced } });
});

export default sync;
