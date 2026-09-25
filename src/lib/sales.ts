// Núcleo de venta COMPARTIDO por POST /sales y POST /sales/sync.
//
// Antes cada ruta repetía su propia versión de "crear venta" y cada una tenía
// huecos distintos (sync no validaba moneda ni producto inactivo, ninguna
// comprobaba stock con escritura atómica, una usaba `usedCount` — columna que
// no existe — y por eso una venta con descuento reventaba en runtime). Aquí
// vive UNA sola implementación, con la que las dos rutas se comportan igual.
//
// Garantía de integridad (D1): venta + líneas + descuento de stock + movimientos
// + contadores de descuentos + auditoría se escriben en UN `db.batch()`, que es
// una transacción. Si algo falla (índice único, trigger de stock, FK), no
// queda ninguna venta a medias.

import { and, eq, gte, lt, count } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import type { AuthContext } from "../middleware/auth";
import { generateUUID } from "./jwt";
import { nextInvoiceNumber } from "./invoiceNumber";
import { PLAN_LIMITS } from "../middleware/plans";
import { getAllowedCurrencies } from "./companySettings";
import { computeDiscountAmount, isDiscountAvailable, type DiscountRow } from "./discountRules";
import {
  ensureLocationStockStmt,
  decrementStockStmt,
  incrementStockStmt as incrementStockStmtPublic,
  recomputeProductStockStmt,
  stockMovementStmt,
  consumeDiscountStmt,
  releaseDiscountStmt as releaseDiscountStmtPublic,
  auditStmt,
  runBatch,
  isClientSaleConflict,
  errorMessage,
} from "./batch";
import { resolveOwnLocation, getActiveCompanyLocation, getLocationStockQty } from "./locations";

type DB = ReturnType<typeof drizzle>;

// ── Límites de la API ────────────────────────────────────────────────────────
export const MAX_ITEMS_PER_SALE = 200;
export const MAX_SYNC_BATCH = 200;
export const MAX_CLIENT_SALE_ID_LEN = 64;
const MAX_QTY = 1_000_000;

// Métodos de pago que la app sabe manejar. Desconocidos → 400, no se guardan.
export const ALLOWED_PAY_METHODS = [
  "efectivo", "transferencia", "usd", "clasica", "zelle", "mlc", "eur", "tarjeta",
] as const;

export interface SaleLineInput {
  productId: string;
  qty: number;
  discountId?: string | null;
}

export interface CreateSaleInput {
  clientSaleId?: string | null;
  clientName?: string;
  clientNit?: string;
  clientPhone?: string;
  currency?: string;
  payMethod: string;
  locationId?: string | null;
  items: SaleLineInput[];
  discountId?: string | null;
  /** Momento en que el cliente la registró (offline). Solo para auditoría. */
  offlineTimestamp?: number | null;
  synced?: boolean;
  ip?: string | null;
  /**
   * Ventas ya aceptadas del mismo lote de sincronización. Se suman al límite
   * del plan para que un lote offline no se cuele por encima del tope mensual.
   */
  alreadyInBatch?: number;
}

export interface SaleFailure {
  ok: false;
  status: number;
  error: string;
  code?: string;
  /** El cliente puede reintentar tal cual (fallo de red/D1, no de datos). */
  retryable?: boolean;
}

export interface SaleSuccess {
  ok: true;
  duplicate: boolean;
  sale: typeof schema.sales.$inferSelect;
  items: (typeof schema.saleItems.$inferSelect)[];
}

export type CreateSaleResult = SaleSuccess | SaleFailure;

function fail(status: number, error: string, code?: string, retryable?: boolean): SaleFailure {
  return { ok: false, status, error, code, retryable };
}

/** Redondeo monetario a 2 decimales; el total nunca se guarda con ruido float. */
function money(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * clientSaleId: lo genera el cliente (UUID del POS o de la cola offline).
 * Solo se acepta como cadena corta y con caracteres de identificador — evita
 * guardar basura o payloads enormes dentro del índice único.
 */
export function validateClientSaleId(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
  if (raw === undefined || raw === null || raw === "") {
    return { ok: true, value: "" };
  }
  if (typeof raw !== "string") return { ok: false, error: "clientSaleId debe ser texto" };
  const value = raw.trim();
  if (!value) return { ok: true, value: "" };
  if (value.length > MAX_CLIENT_SALE_ID_LEN) {
    return { ok: false, error: `clientSaleId demasiado largo (máx. ${MAX_CLIENT_SALE_ID_LEN})` };
  }
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    return { ok: false, error: "clientSaleId solo puede letras, números y . _ : -" };
  }
  return { ok: true, value };
}

export function isValidQuantity(qty: unknown): qty is number {
  return typeof qty === "number" && Number.isFinite(qty) && qty > 0 && qty <= MAX_QTY;
}

/**
 * Dónde se descuenta el stock de esta venta:
 *  - cajero     → SU caja (obligatorio, no se puede vender en la de otro)
 *  - almacenista→ el almacén central activo
 *  - admin      → la ubicación que indique explícitamente (obligatoria)
 *  - contador   → no vende (queda fuera por permisos, pero se valida igual)
 */
export async function resolveSaleLocation(
  db: DB,
  auth: AuthContext,
  requestedLocationId?: string | null
): Promise<{ ok: true; location: typeof schema.inventoryLocations.$inferSelect } | SaleFailure> {
  const own = await resolveOwnLocation(db, auth);
  if (own) {
    // Un cajero/almacenista que además mande locationId no puede usarla para
    // vender fuera de su ubicación: su ubicación manda siempre.
    return { ok: true, location: own };
  }

  if (auth.role === "admin") {
    if (!requestedLocationId) {
      return fail(400, "Los administradores deben indicar en qué ubicación se realiza la venta (locationId)", "LOCATION_REQUIRED");
    }
    const loc = await getActiveCompanyLocation(db, auth.companyId, requestedLocationId);
    if (!loc) return fail(404, "La ubicación indicada no existe o está inactiva", "LOCATION_NOT_FOUND");
    return { ok: true, location: loc };
  }

  if (requestedLocationId) {
    return fail(403, "No puede vender en una ubicación que no es la suya", "LOCATION_FORBIDDEN");
  }
  return fail(400, "No tiene una ubicación de venta asignada. Contacte al administrador.", "LOCATION_MISSING");
}

/**
 * Límite de ventas del plan, evaluado con la FECHA DEL SERVIDOR.
 *
 * `alreadyInBatch` son las ventas YA aceptadas del lote offline en curso: el
 * contador de la base todavía no las refleja (cada venta se confirma por
 * separado), así que sin sumarlas un lote de 200 ventas en un plan free se
 * colaría por encima del tope del mes.
 */
export async function checkSalesPlanLimit(
  db: DB,
  companyId: string,
  alreadyInBatch = 0
): Promise<SaleFailure | null> {
  const company = await db.select().from(schema.companies)
    .where(eq(schema.companies.id, companyId)).get();
  if (!company) return fail(404, "Empresa no encontrada", "COMPANY_NOT_FOUND");

  const expired = company.planExpiry && new Date(company.planExpiry) < new Date();
  const planKey = expired ? "free" : company.plan || "free";
  const planData = PLAN_LIMITS[planKey];
  if (!planData || planData.maxSalesMonth === null) return null;

  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split("T")[0];
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0).toISOString().split("T")[0];
  const cnt = await db.select({ value: count() }).from(schema.sales)
    .where(and(
      eq(schema.sales.companyId, companyId),
      gte(schema.sales.date, start),
      lt(schema.sales.date, end),
    )).get();
  const used = (cnt?.value ?? 0) + Math.max(0, alreadyInBatch);
  if (used >= planData.maxSalesMonth) {
    return fail(
      403,
      `Tu plan ${planKey} permite máximo ${planData.maxSalesMonth} ventas al mes. Has alcanzado el límite de este mes. Actualiza tu plan para continuar.`,
      "PLAN_LIMIT_SALES"
    );
  }
  return null;
}

export async function loadSaleWithItems(db: DB, companyId: string, saleId: string) {
  const sale = await db.select().from(schema.sales)
    .where(and(eq(schema.sales.id, saleId), eq(schema.sales.companyId, companyId))).get();
  if (!sale) return null;
  const items = await db.select().from(schema.saleItems)
    .where(eq(schema.saleItems.saleId, sale.id)).all();
  return { sale, items };
}

/** Venta ya existente para un clientSaleId (reintento idempotente). */
export async function findSaleByClientSaleId(db: DB, companyId: string, clientSaleId: string) {
  return db.select().from(schema.sales)
    .where(and(
      eq(schema.sales.companyId, companyId),
      eq(schema.sales.clientSaleId, clientSaleId),
    ))
    .get();
}

// ── Creación de la venta ─────────────────────────────────────────────────────
export async function createSale(
  env: Env,
  db: DB,
  auth: AuthContext,
  input: CreateSaleInput
): Promise<CreateSaleResult> {
  // 0) Idempotencia: si el cliente ya mandó esta venta, devolvemos la misma
  //    factura en vez de crear otra. La carrera real la corta el índice único
  //    (company_id, client_sale_id) de la migration 0007, tratado más abajo.
  const clientId = (input.clientSaleId || "").trim();
  if (clientId) {
    const existing = await findSaleByClientSaleId(db, auth.companyId, clientId);
    if (existing) {
      const loaded = await loadSaleWithItems(db, auth.companyId, existing.id);
      if (loaded) return { ok: true, duplicate: true, sale: loaded.sale, items: loaded.items };
    }
  }

  // 1) Validaciones de cabecera
  if (!input.payMethod || typeof input.payMethod !== "string") {
    return fail(400, "payMethod es requerido", "PAY_METHOD_REQUIRED");
  }
  if (!(ALLOWED_PAY_METHODS as readonly string[]).includes(input.payMethod)) {
    return fail(400, "Método de pago inválido", "PAY_METHOD_INVALID");
  }
  if (!Array.isArray(input.items) || input.items.length === 0) {
    return fail(400, "La venta debe tener al menos un producto", "ITEMS_REQUIRED");
  }
  if (input.items.length > MAX_ITEMS_PER_SALE) {
    return fail(400, `La venta no puede tener más de ${MAX_ITEMS_PER_SALE} productos`, "ITEMS_TOO_MANY");
  }

  const company = await db.select().from(schema.companies)
    .where(eq(schema.companies.id, auth.companyId)).get();
  if (!company) return fail(404, "Empresa no encontrada", "COMPANY_NOT_FOUND");

  // 2) Ubicación (inmutable: es la que queda en la venta y en cada movimiento)
  const locResult = await resolveSaleLocation(db, auth, input.locationId);
  if (!locResult.ok) return locResult;
  const location = locResult.location;

  // 3) Moneda: la venta solo puede usar monedas que la empresa opere.
  const allowedCurrencies = await getAllowedCurrencies(db, auth.companyId, company.defaultCurrency || "CUP");
  const saleCurrency = (input.currency || company.defaultCurrency || "CUP").toUpperCase();
  if (!allowedCurrencies.includes(saleCurrency)) {
    return fail(400, `La moneda ${saleCurrency} no está habilitada para tu negocio`, "CURRENCY_NOT_ALLOWED");
  }

  // 4) Límite del plan (fecha del servidor, no la del dispositivo). Incluye
  //    las ventas ya aceptadas de este mismo lote de sincronización.
  const planFailure = await checkSalesPlanLimit(db, auth.companyId, input.alreadyInBatch ?? 0);
  if (planFailure) return planFailure;

  // 5) Productos: deben ser de ESTA empresa y estar activos. Una venta
  //    offline puede intentar vender algo que se desactivó o que es de otra
  //    empresa: en ambos casos no entra.
  const productIds: string[] = [];
  for (const it of input.items) {
    if (!it || typeof it.productId !== "string" || !it.productId) {
      return fail(400, "Cada línea necesita un productId", "ITEM_INVALID");
    }
    if (!isValidQuantity(it.qty)) {
      return fail(400, `Cantidad inválida para el producto ${it.productId}`, "QTY_INVALID");
    }
    if (productIds.includes(it.productId)) {
      return fail(400, "La venta tiene el mismo producto en dos líneas. Únelas en una sola.", "DUPLICATE_PRODUCT");
    }
    productIds.push(it.productId);
  }

  const products = await db.select().from(schema.products)
    .where(and(eq(schema.products.companyId, auth.companyId))).all();
  const productById = new Map(products.map((p) => [p.id, p]));

  // 6) Descuentos: availability + ámbito correctos, y el código de venta.
  const discountIds: string[] = [];
  if (input.discountId) discountIds.push(input.discountId);
  for (const it of input.items) if (it.discountId) discountIds.push(it.discountId);
  const discountById = new Map<string, typeof schema.discounts.$inferSelect>();
  if (discountIds.length > 0) {
    const rows = await db.select().from(schema.discounts)
      .where(and(eq(schema.discounts.companyId, auth.companyId))).all();
    for (const d of rows) discountById.set(d.id, d);
    for (const id of discountIds) {
      if (!discountById.has(id)) return fail(404, "Descuento no encontrado", "DISCOUNT_NOT_FOUND");
    }
  }

  // 7) Cálculo TOTAL en el servidor. El cliente manda quantities, no precios:
  //    precio, descuentos, impuesto y total se calculan aquí, con los datos de
  //    la base de datos, y son los que se guardan.
  const now = new Date();
  const saleDate = now.toISOString().split("T")[0];
  const lines: {
    product: typeof schema.products.$inferSelect;
    qty: number;
    lineTotal: number;
    lineDiscount: number;
    discount: typeof schema.discounts.$inferSelect | null;
  }[] = [];
  let subtotal = 0;

  for (const it of input.items) {
    const product = productById.get(it.productId);
    if (!product) return fail(404, `Producto ${it.productId} no encontrado`, "PRODUCT_NOT_FOUND");
    if (!product.active) return fail(400, `El producto "${product.name}" está desactivado`, "PRODUCT_INACTIVE");

    // Moneda del producto vs. moneda de la venta: no se mezclan importes.
    // (P0 no convierte monedas; simplemente no se permite vender un producto en
    // USD dentro de una venta en CUP.)
    const productCurrency = (product.currency || "CUP").toUpperCase();
    if (productCurrency !== saleCurrency) {
      return fail(
        400,
        `"${product.name}" está en ${productCurrency} y la venta es en ${saleCurrency}. No se pueden mezclar monedas.`,
        "CURRENCY_MISMATCH"
      );
    }

    const qty = Number(it.qty);
    const available = await getLocationStockQty(db, location.id, product.id);
    if (available < qty) {
      return fail(
        409,
        `Stock insuficiente para ${product.name} en ${location.name} (disponible: ${available})`,
        "STOCK_INSUFFICIENT"
      );
    }

    const lineTotal = money(Number(product.price) * qty);
    let lineDiscount = 0;
    let discountRow: typeof schema.discounts.$inferSelect | null = null;
    if (it.discountId) {
      const d = discountById.get(it.discountId)!;
      const check = isDiscountAvailable(d as unknown as DiscountRow, location.id);
      if (!check.ok) return fail(409, `${product.name}: ${check.reason}`, "DISCOUNT_UNAVAILABLE");
      if (d.scope !== "producto") return fail(400, "Este descuento es por venta, no por producto", "DISCOUNT_SCOPE");
      lineDiscount = money(computeDiscountAmount(d as unknown as DiscountRow, lineTotal, qty));
      discountRow = d;
    }
    subtotal += lineTotal;
    lines.push({ product, qty, lineTotal, lineDiscount, discount: discountRow });
  }

  let saleDiscount: typeof schema.discounts.$inferSelect | null = null;
  if (input.discountId) {
    const d = discountById.get(input.discountId)!;
    const check = isDiscountAvailable(d as unknown as DiscountRow, location.id);
    if (!check.ok) return fail(409, check.reason, "DISCOUNT_UNAVAILABLE");
    if (d.scope !== "venta") return fail(400, "Este descuento es por producto, no por venta", "DISCOUNT_SCOPE");
    saleDiscount = d;
  }

  const lineDiscountsTotal = lines.reduce((a, l) => a + l.lineDiscount, 0);
  const saleLevelDiscount = saleDiscount
    ? money(computeDiscountAmount(saleDiscount as unknown as DiscountRow, subtotal, undefined))
    : 0;
  const totalDiscount = money(saleLevelDiscount + lineDiscountsTotal);

  const taxRate = Number(company.taxRate ?? 0);
  const taxableBase = Math.max(0, money(subtotal - totalDiscount));
  const tax = money(taxableBase * taxRate);
  const total = money(taxableBase + tax);

  // 8) Factura correlativa (contador atómico existente — se conserva tal cual)
  const invoiceNumber = await nextInvoiceNumber(env, auth.companyId);

  const saleId = generateUUID();
  const offlineNote = input.offlineTimestamp
    ? ` (registrada offline el ${new Date(input.offlineTimestamp).toISOString()})`
    : "";

  // 9) El batch: una transacción. Cualquier fallo revierte TODO.
  const stmts: D1PreparedStatement[] = [];
  for (const l of lines) stmts.push(ensureLocationStockStmt(env.DB, location.id, l.product.id));

  stmts.push(
    env.DB.prepare(
      `INSERT INTO sales (id, company_id, invoice_number, user_id, location_id, date,
                          client_name, client_nit, client_phone, subtotal, tax, total,
                          currency, pay_method, discount_code, discount_total, discount_id,
                          client_sale_id, status, synced_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'emitida', ?, unixepoch())`
    ).bind(
      saleId, auth.companyId, invoiceNumber, auth.userId, location.id, saleDate,
      input.clientName || "Consumidor Final", input.clientNit || "00000000000",
      input.clientPhone || null, subtotal, tax, total, saleCurrency, input.payMethod,
      saleDiscount?.code ?? null, totalDiscount, saleDiscount?.id ?? null,
      clientId || null, input.synced ? unixepochNow() : null
    )
  );

  for (const l of lines) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO sale_items (id, sale_id, product_id, name, qty, price, total, discount_id, discount_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        generateUUID(), saleId, l.product.id, l.product.name, l.qty,
        Number(l.product.price), l.lineTotal, l.discount?.id ?? null, l.lineDiscount
      )
    );
  }

  for (const l of lines) {
    stmts.push(decrementStockStmt(env.DB, location.id, l.product.id, l.qty));
    stmts.push(
      stockMovementStmt(env.DB, {
        companyId: auth.companyId,
        productId: l.product.id,
        userId: auth.userId,
        locationId: location.id,
        type: "venta",
        qty: l.qty,
        reason: `Venta ${invoiceNumber} (${location.name})${offlineNote}`,
      })
    );
    stmts.push(recomputeProductStockStmt(env.DB, l.product.id));
  }

  const usedDiscountIds = new Set<string>();
  if (saleDiscount) usedDiscountIds.add(saleDiscount.id);
  for (const l of lines) if (l.discount) usedDiscountIds.add(l.discount.id);
  for (const id of usedDiscountIds) stmts.push(consumeDiscountStmt(env.DB, id));

  stmts.push(
    auditStmt(env.DB, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: "sale.create",
      entity: "sale",
      entityId: saleId,
      detail: {
        invoiceNumber,
        total,
        currency: saleCurrency,
        location: location.name,
        items: lines.length,
        clientSaleId: clientId || null,
        offline: !!input.synced,
      },
      ip: input.ip ?? null,
    })
  );

  try {
    await runBatch(env.DB, stmts);
  } catch (err) {
    // Dos peticiones con el mismo clientSaleId: la segunda no crea nada y
    // devolvemos la factura original (idempotencia real, no un error).
    if (clientId && isClientSaleConflict(err)) {
      const existing = await findSaleByClientSaleId(db, auth.companyId, clientId);
      if (existing) {
        const loaded = await loadSaleWithItems(db, auth.companyId, existing.id);
        if (loaded) return { ok: true, duplicate: true, sale: loaded.sale, items: loaded.items };
      }
    }
    console.error("createSale: batch falló y se revirtió:", errorMessage(err));
    const msg = errorMessage(err);
    if (/stock insuficiente/i.test(msg)) {
      return fail(409, "Stock insuficiente en la ubicación de la venta", "STOCK_INSUFFICIENT");
    }
    if (/descuento agotado/i.test(msg)) {
      return fail(409, "El descuento se agotó mientras se procesaba la venta", "DISCOUNT_EXHAUSTED");
    }
    if (/UNIQUE constraint failed: sales\.company_id, sales\.invoice_number/i.test(msg)) {
      return fail(503, "No se pudo asignar un número de factura. Reintente la venta.", "INVOICE_CONFLICT", true);
    }
    return fail(500, "No se pudo registrar la venta. Inténtalo de nuevo.", "SALE_COMMIT_FAILED", true);
  }

  const loaded = await loadSaleWithItems(db, auth.companyId, saleId);
  if (!loaded) return fail(500, "La venta se guardó pero no se pudo leer. Reintenta la sincronización.", "SALE_READ_BACK", true);
  return { ok: true, duplicate: false, sale: loaded.sale, items: loaded.items };
}

// ── Anulación ────────────────────────────────────────────────────────────────
// Idempotente: anular dos veces la misma venta devuelve la misma respuesta y
// devuelve el stock UNA sola vez. Antes el segundo POST repetía la entrada de
// stock y los movimientos, duplicando el inventario.
//
// La garantía de "una sola vez" no depende de esta función: la da
// trg_sales_void_once (0007), que aborta el batch si alguien intenta anular
// una venta que ya está anulada. Aquí la comprobación previa solo evita
// escribir y devuelve una respuesta limpia al cliente.
export async function voidSale(
  env: Env,
  db: DB,
  auth: AuthContext,
  saleId: string,
  opts: { ip?: string | null } = {}
): Promise<
  | { ok: true; alreadyVoided: boolean; sale: typeof schema.sales.$inferSelect }
  | SaleFailure
> {
  const loaded = await loadSaleWithItems(db, auth.companyId, saleId);
  if (!loaded) return fail(404, "Venta no encontrada", "SALE_NOT_FOUND");
  const { sale, items } = loaded;

  if (sale.status === "anulada") {
    // Ya anulada: responder OK es lo correcto para un reintento del cliente.
    return { ok: true, alreadyVoided: true, sale };
  }

  // Permisos: admin sobre cualquier venta de su empresa; el resto solo sobre
  // las suyas. Un cajero no anula la venta de otro cajero aunque comparta caja.
  if (auth.role !== "admin" && sale.userId !== auth.userId) {
    return fail(403, "Solo el cajero que hizo la venta (o un administrador) puede anularla", "SALE_FORBIDDEN");
  }

  if (!sale.locationId) {
    return fail(409, "Esta venta no tiene ubicación de inventario; anúlala desde el panel de soporte", "SALE_NO_LOCATION");
  }
  const locationId = sale.locationId;

  const stmts: D1PreparedStatement[] = [
    // Reclamo de la anulación.
    //
    // IMPORTANTE: SIN `AND status = 'emitida'`. Con ese filtro, la segunda
    // anulación (simultánea o repetida) dejaría la fila fuera del UPDATE, el
    // trigger NUNCA se dispararía y el resto del lote —devolución de stock y
    // contador de descuentos— se aplicaría igual: el inventario quedaría
    // duplicado. Sin el filtro, el UPDATE sí toca la fila y
    // trg_sales_void_once (0007) aborta el batch entero; el catch de más abajo
    // traduce ese error en una respuesta idempotente.
    env.DB.prepare(`UPDATE sales SET status = 'anulada' WHERE id = ?`)
      .bind(sale.id),
  ];

  for (const item of items) {
    if (!item.productId) continue;
    const qty = Number(item.qty);
    if (!Number.isFinite(qty) || qty <= 0) continue;
    stmts.push(ensureLocationStockStmt(env.DB, locationId, item.productId));
    stmts.push(incrementStockStmtPublic(env.DB, locationId, item.productId, qty));
    stmts.push(
      stockMovementStmt(env.DB, {
        companyId: auth.companyId,
        productId: item.productId,
        userId: auth.userId,
        locationId,
        type: "entrada",
        qty,
        reason: `Anulación ${sale.invoiceNumber}`,
      })
    );
    stmts.push(recomputeProductStockStmt(env.DB, item.productId));
  }

  // El uso del descuento se devuelve al contador, una sola vez (esta venta ya
  // está en 'anulada', así que el trigger de "no anular dos veces" impide que
  // un segundo intento lo devuelva otra vez).
  const releaseIds = new Set<string>();
  if (sale.discountId) releaseIds.add(sale.discountId);
  for (const item of items) if (item.discountId) releaseIds.add(item.discountId);
  for (const id of releaseIds) stmts.push(releaseDiscountStmtPublic(env.DB, id));

  stmts.push(
    auditStmt(env.DB, {
      companyId: auth.companyId,
      userId: auth.userId,
      action: "sale.void",
      entity: "sale",
      entityId: sale.id,
      detail: { invoiceNumber: sale.invoiceNumber, total: Number(sale.total), items: items.length },
      ip: opts.ip ?? null,
    })
  );

  try {
    await runBatch(env.DB, stmts);
  } catch (err) {
    const msg = errorMessage(err);
    if (/ya estaba anulada/i.test(msg)) {
      const after = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id)).get();
      if (after) return { ok: true, alreadyVoided: true, sale: after };
    }
    console.error("voidSale: batch falló y se revirtió:", msg);
    return fail(500, "No se pudo anular la venta. Inténtalo de nuevo.", "VOID_COMMIT_FAILED", true);
  }

  const after = await db.select().from(schema.sales).where(eq(schema.sales.id, sale.id)).get();
  if (!after) return fail(500, "La venta se anuló pero no se pudo leer.", "VOID_READ_BACK", true);
  return { ok: true, alreadyVoided: false, sale: after };
}

function unixepochNow(): number {
  return Math.floor(Date.now() / 1000);
}
