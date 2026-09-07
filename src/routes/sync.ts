import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { authMiddleware } from "../middleware/auth";
import { requireModule } from "../middleware/roles";
import { checkLimit } from "../middleware/plans";
import { generateUUID } from "../lib/jwt";
import { nextInvoiceNumber } from "../lib/invoiceNumber";
import { resolveOwnLocation, getLocationStockQty, adjustLocationStock } from "../lib/locations";

const sync = new Hono<{ Bindings: Env }>();

sync.use("*", authMiddleware);

// POST /sales/sync
// Recibe un array de ventas generadas offline, las procesa en orden cronológico,
// valida stock en tiempo real y retorna el resultado por cada venta.
sync.post("/", requireModule("pos"), checkLimit("sales"), async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const auth = c.get("auth");
  const body = await c.req.json<{ sales: any[] }>();
  const { sales: offlineSales } = body;

  if (!Array.isArray(offlineSales) || offlineSales.length === 0) {
    return c.json({ ok: false, error: "No hay ventas para sincronizar" }, 400);
  }

  // Misma ubicación para todas las ventas de este lote: son todas del mismo
  // dispositivo/cajero que estuvo offline.
  const location = await resolveOwnLocation(db, auth);
  if (!location) {
    return c.json({ ok: false, error: "No tiene una ubicación de venta asignada" }, 400);
  }

  // Cargar taxRate de la empresa una sola vez
  const company = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, auth.companyId))
    .get();
  const taxRate = Number(company?.taxRate ?? 0);

  const results: any[] = [];

  // Ordenar por timestamp offline para respetar el orden cronológico de las ventas
  const sorted = [...offlineSales].sort(
    (a, b) => (a.offlineTimestamp || 0) - (b.offlineTimestamp || 0)
  );

  for (const saleData of sorted) {
    try {
      const { clientName, clientNit, clientPhone, currency, payMethod, items, offlineTimestamp, localId } = saleData;

      if (!Array.isArray(items) || items.length === 0) {
        results.push({ localId, status: "conflict", reason: "La venta no tiene items" });
        continue;
      }

      let subtotal = 0;
      const processedItems: {
        product: typeof schema.products.$inferSelect;
        qty: number;
        price: number;
        total: number;
        itemName: string;
      }[] = [];

      // Validar stock de cada producto (en la ubicación del cajero) antes de procesar
      for (const item of items) {
        const product = await db
          .select()
          .from(schema.products)
          .where(
            and(
              eq(schema.products.id, item.productId),
              eq(schema.products.companyId, auth.companyId)
            )
          )
          .get();

        if (!product) {
          throw new Error(`Producto no encontrado: ${item.productId}`);
        }

        const qty = Number(item.qty);
        const available = await getLocationStockQty(db, location.id, product.id);
        if (available < qty) {
          throw new Error(
            `Stock insuficiente para '${product.name}' en ${location.name} — disponible: ${available}, solicitado: ${qty}`
          );
        }

        const lineTotal = Number(product.price) * qty;
        subtotal += lineTotal;
        processedItems.push({
          product,
          qty,
          price: Number(product.price),
          total: lineTotal,
          itemName: item.name || product.name,
        });
      }

      // FIX: calcular impuesto igual que en ventas online
      const tax = parseFloat((subtotal * taxRate).toFixed(2));
      const total = parseFloat((subtotal + tax).toFixed(2));

      // Número de factura atómico — garantiza unicidad bajo concurrencia
      const invoiceNumber = await nextInvoiceNumber(c.env, auth.companyId);

      const saleDate = offlineTimestamp
        ? new Date(offlineTimestamp).toISOString().split("T")[0]
        : new Date().toISOString().split("T")[0];

      const saleId = generateUUID();

      await db.insert(schema.sales).values({
        id: saleId,
        companyId: auth.companyId,
        userId: auth.userId,
        locationId: location.id,
        invoiceNumber,
        date: saleDate,
        clientName: clientName || "Consumidor Final",
        clientNit: clientNit || "00000000000",
        clientPhone: clientPhone || null,
        subtotal,
        tax,
        total,
        currency: currency || company?.defaultCurrency || "CUP",
        payMethod,
        status: "emitida",
        syncedAt: new Date(),
      });

      for (const { product, qty, price, total: lineTotal, itemName } of processedItems) {
        await db.insert(schema.saleItems).values({
          id: generateUUID(),
          saleId,
          productId: product.id,
          name: itemName,
          qty,
          price,
          total: lineTotal,
        });

        await adjustLocationStock(db, location.id, product.id, -qty);

        await db.insert(schema.stockMovements).values({
          id: generateUUID(),
          companyId: auth.companyId,
          productId: product.id,
          userId: auth.userId,
          type: "venta",
          qty,
          reason: `Venta ${invoiceNumber} (sincronización offline, ${location.name})`,
        });
      }

      results.push({ localId, status: "synced", serverId: saleId, invoiceNumber });
    } catch (err: any) {
      results.push({ localId: saleData.localId, status: "conflict", reason: err.message });
    }
  }

  return c.json({ ok: true, data: results });
});

export default sync;
