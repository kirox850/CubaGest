import { sqliteTable, text, integer, real, index, uniqueIndex } from "drizzle-orm/sqlite-core";

export const companies = sqliteTable("companies", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  nit: text("nit"),
  defaultCurrency: text("default_currency", { enum: ["CUP", "MLC", "USD"] }).notNull().default("CUP"),
  taxRate: real("tax_rate").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  plan: text("plan", { enum: ["free", "pro", "empresarial"] }).notNull().default("empresarial"),
  planExpiry: integer("plan_expiry", { mode: "timestamp" }),
  subscriptionStatus: text("subscription_status", { enum: ["trial", "active", "failed", "cancelled", "none"] }).notNull().default("trial"),
  paymentMethod: text("payment_method", { enum: ["qvapay", "whatsapp"] }),
  qvapayUserUuid: text("qvapay_user_uuid"),
  // Token de autorización devuelto por QvaPay tras el authorize_payments
  // (campo "auth_secret" del payload del callback). Es lo que hay que
  // reenviar en cada /v2/charge — el user_uuid solo no basta para cobrar,
  // ver documentación del SDK oficial de QvaPay (charge_user(token=...)).
  // NUNCA loguear este valor.
  qvapayAuthSecret: text("qvapay_auth_secret"),
  qvapayAuthorized: integer("qvapay_authorized", { mode: "boolean" }).notNull().default(false),
  lastPaymentDate: integer("last_payment_date", { mode: "timestamp" }),
  nextPaymentDate: integer("next_payment_date", { mode: "timestamp" }),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  // Programa de referidos: código único de esta empresa para invitar a
  // otras (columnas añadidas en migration 0005).
  referralCode: text("referral_code"),
  referredBy: text("referred_by"),
  // Notas internas del panel de plataforma (migration 0006) — nunca se
  // exponen al cliente; solo el super-admin las ve en /panel.
  internalNotes: text("internal_notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ── Panel de plataforma (super-admin) — migration 0006 ─────────────────────
// Identidad separada del login de empresas. Un solo nivel de acceso (eres
// tú); nada de sub-roles. El token de estas cuentas lleva claim
// type:"platform" y el middleware normal lo rechaza.
export const platformAdmins = sqliteTable("platform_admins", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  name: text("name").notNull().default("Admin de Plataforma"),
  passwordHash: text("password_hash").notNull(),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Auditoría del panel, separada del audit_logs de empresas (ese exige
// company_id NOT NULL y las acciones de plataforma son multi-empresa).
export const platformAuditLogs = sqliteTable("platform_audit_logs", {
  id: text("id").primaryKey(),
  adminId: text("admin_id").references(() => platformAdmins.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id"),
  detail: text("detail"),
  ip: text("ip"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Autorización de pago de un solo uso (migration 0008).
//
// Antes, el callback de QvaPay traía `remote_id = "<companyId>:<plan>"` y el
// backend leía empresa y plan de la URL: cualquiera podía abrir esa URL con
// el id de una empresa y activarle un plan pagado, o cambiarle el user_uuid
// al que se le cobra la renovación. Ahora `state` es un token aleatorio de
// 256 bits creado por el propio admin al pulsar "Activar plan", y esta tabla
// es la única fuente de verdad de a qué empresa y plan pertenece.
export const paymentAuthorizations = sqliteTable("payment_authorizations", {
  state: text("state").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  plan: text("plan").notNull(),
  userId: text("user_id"),
  qvapayUserUuid: text("qvapay_user_uuid"),
  status: text("status", { enum: ["pending", "charging", "charged", "failed"] }).notNull().default("pending"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  completedAt: integer("completed_at", { mode: "timestamp" }),
  error: text("error"),
}, (table) => ({
  statusIdx: index("pa_status_idx").on(table.status),
  companyIdx: index("pa_company_idx").on(table.companyId),
  createdIdx: index("pa_created_idx").on(table.createdAt),
}));

export const users = sqliteTable("users", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: text("role", { enum: ["admin", "cajero", "contador", "almacenista"] }).notNull().default("cajero"),
  nit: text("nit"),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  lastLoginAt: integer("last_login_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("users_company_idx").on(table.companyId),
  emailIdx: uniqueIndex("users_email_idx").on(table.companyId, table.email),
}));

export const products = sqliteTable("products", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  code: text("code").notNull(),
  barcode: text("barcode"), // código de barras opcional (escaneable en el POS)
  currency: text("currency").notNull().default("CUP"), // moneda del precio
  name: text("name").notNull(),
  category: text("category").notNull().default("Otros"),
  unit: text("unit").notNull().default("ud"),
  price: real("price").notNull(),
  cost: real("cost").notNull().default(0),
  // Stock TOTAL de la empresa (suma de todas las ubicaciones) — se recalcula
  // automáticamente cada vez que cambia location_stock. Sirve para el
  // dashboard/alertas de stock bajo a nivel de empresa, pero NUNCA se usa
  // para vender ni para descontar directamente: eso siempre pasa por
  // location_stock (ver inventoryLocations/locationStock más abajo).
  stock: real("stock").notNull().default(0),
  minStock: real("min_stock").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("products_company_idx").on(table.companyId),
  codeIdx: uniqueIndex("products_code_idx").on(table.companyId, table.code),
}));

// ── Inventario multi-ubicación ───────────────────────────────────────────────
// Cada empresa tiene UN almacén central ("almacen") y, opcionalmente, una
// "caja" por cada usuario cajero — su inventario personal e independiente.
// El stock real y operativo vive en locationStock, no en products.stock.
export const inventoryLocations = sqliteTable("inventory_locations", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  type: text("type", { enum: ["almacen", "caja"] }).notNull(),
  // Dueño de la ubicación. NULL para el almacén (es de la empresa, no de una
  // persona). Para una "caja" es el cajero dueño de ese inventario/caja.
  ownerUserId: text("owner_user_id").references(() => users.id, { onDelete: "set null" }),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("locations_company_idx").on(table.companyId),
  ownerIdx: index("locations_owner_idx").on(table.ownerUserId),
}));

export const locationStock = sqliteTable("location_stock", {
  id: text("id").primaryKey(),
  locationId: text("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  qty: real("qty").notNull().default(0),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  locationIdx: index("location_stock_location_idx").on(table.locationId),
  productIdx: index("location_stock_product_idx").on(table.productId),
  uniqueLocationProduct: uniqueIndex("location_stock_unique_idx").on(table.locationId, table.productId),
}));

// Envío de productos entre dos ubicaciones. El stock se descuenta del
// origen SOLO cuando el destino aprueba — mientras está "pendiente" sigue
// disponible normalmente en el origen (se puede vender/usar/cancelar sin
// problema). Si se rechaza, no hay que revertir nada porque nunca se movió.
export const stockTransfers = sqliteTable("stock_transfers", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  fromLocationId: text("from_location_id").notNull().references(() => inventoryLocations.id),
  toLocationId: text("to_location_id").notNull().references(() => inventoryLocations.id),
  requestedById: text("requested_by_id").notNull().references(() => users.id),
  resolvedById: text("resolved_by_id").references(() => users.id),
  status: text("status", { enum: ["pendiente", "aprobado", "rechazado", "cancelado"] }).notNull().default("pendiente"),
  notes: text("notes"),
  rejectReason: text("reject_reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  resolvedAt: integer("resolved_at", { mode: "timestamp" }),
}, (table) => ({
  companyIdx: index("transfers_company_idx").on(table.companyId),
  fromIdx: index("transfers_from_idx").on(table.fromLocationId),
  toIdx: index("transfers_to_idx").on(table.toLocationId),
  statusIdx: index("transfers_status_idx").on(table.status),
}));

export const stockTransferItems = sqliteTable("stock_transfer_items", {
  id: text("id").primaryKey(),
  transferId: text("transfer_id").notNull().references(() => stockTransfers.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id),
  productCode: text("product_code").notNull(),
  productName: text("product_name").notNull(),
  unit: text("unit").notNull(),
  qty: real("qty").notNull(),
}, (table) => ({
  transferIdx: index("transfer_items_transfer_idx").on(table.transferId),
}));

export const sales = sqliteTable("sales", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  invoiceNumber: text("invoice_number").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "set null" }),
  // Ubicación (caja) donde se hizo la venta — de aquí se descuenta el stock
  // y por aquí se filtra el cierre de caja de cada cajero independientemente.
  locationId: text("location_id").references(() => inventoryLocations.id, { onDelete: "set null" }),
  date: text("date").notNull(),
  clientName: text("client_name").notNull().default("Consumidor Final"),
  clientNit: text("client_nit"),
  clientPhone: text("client_phone"),
  subtotal: real("subtotal").notNull(),
  tax: real("tax").notNull().default(0),
  total: real("total").notNull(),
  // currency/payMethod: el enum se amplió a nivel DB (0005) — D1/SQLite no
  // fuerza enums en runtime, la validación real está en la ruta de sales.
  currency: text("currency").notNull().default("CUP"),
  payMethod: text("pay_method").notNull(),
  // Descuento aplicado al TOTAL de la venta (ya restado de `total`).
  discountCode: text("discount_code"),
  discountTotal: real("discount_total").notNull().default(0),
  // Id del descuento de nivel venta (0007). Sin esto, al anular una venta no
  // se podía devolver el uso al contador de ese descuento.
  discountId: text("discount_id").references(() => discounts.id, { onDelete: "set null" }),
  // Idempotencia: UUID que genera el CLIENTE (POS web o cola offline). El
  // índice único (company_id, client_sale_id) de la migration 0007 hace que
  // reenviar la misma venta devuelva la factura original en vez de duplicarla.
  // NULL = venta creada antes de esta columna (sin idempotencia).
  clientSaleId: text("client_sale_id"),
  status: text("status", { enum: ["emitida", "anulada"] }).notNull().default("emitida"),
  syncedAt: integer("synced_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("sales_company_idx").on(table.companyId),
  invoiceIdx: uniqueIndex("sales_invoice_idx").on(table.companyId, table.invoiceNumber),
  // Índice único de idempotencia. En la migration 0007 es PARCIAL
  // (WHERE client_sale_id IS NOT NULL) para que las ventas sin clientSaleId
  // (las anteriores a la columna) no choquen entre sí; aquí se declara sin
  // el WHERE porque solo documenta el acceso y las migraciones de este
  // proyecto son SQL a mano, no generadas por drizzle-kit.
  clientSaleIdx: uniqueIndex("sales_client_sale_idx").on(table.companyId, table.clientSaleId),
  dateIdx: index("sales_date_idx").on(table.date),
  statusIdx: index("sales_status_idx").on(table.status),
}));

export const saleItems = sqliteTable("sale_items", {
  id: text("id").primaryKey(),
  saleId: text("sale_id").notNull().references(() => sales.id, { onDelete: "cascade" }),
  productId: text("product_id").references(() => products.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  qty: real("qty").notNull(),
  price: real("price").notNull(),
  total: real("total").notNull(),
  // Descuento aplicado a esta línea (ya restado del total de la venta)
  discountId: text("discount_id").references(() => discounts.id, { onDelete: "set null" }),
  discountAmount: real("discount_amount").notNull().default(0),
});

export const expenses = sqliteTable("expenses", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  date: text("date").notNull(),
  concept: text("concept").notNull(),
  amount: real("amount").notNull(),
  category: text("category").notNull().default("Otros"),
  method: text("method", { enum: ["efectivo", "mlc", "transferencia", "tarjeta"] }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("expenses_company_idx").on(table.companyId),
  dateIdx: index("expenses_date_idx").on(table.date),
}));

export const stockMovements = sqliteTable("stock_movements", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  productId: text("product_id").notNull().references(() => products.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  // Dónde ocurrió el movimiento (0007). Sin esto no se puede saber en qué caja
  // se descontó o se devolvió el stock. NULL en los movimientos históricos.
  locationId: text("location_id").references(() => inventoryLocations.id, { onDelete: "set null" }),
  type: text("type", { enum: ["entrada", "salida", "venta", "ajuste"] }).notNull(),
  qty: real("qty").notNull(),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("sm_company_idx").on(table.companyId),
  productIdx: index("sm_product_idx").on(table.productId),
  locationIdx: index("sm_location_idx").on(table.locationId),
}));

export const inventoryReadings = sqliteTable("inventory_readings", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  // Ubicación a la que pertenece esta lectura — antes era "toda la empresa"
  // como si fuera un solo inventario; ahora cada caja (y el almacén) llevan
  // su propia lectura/cierre independiente.
  locationId: text("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "cascade" }),
  takenById: text("taken_by_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["apertura", "cierre"] }).notNull(),
  notes: text("notes"),
  items: text("items", { mode: "json" }).notNull().$defaultFn(() => []),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const cashClosings = sqliteTable("cash_closings", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  locationId: text("location_id").notNull().references(() => inventoryLocations.id, { onDelete: "cascade" }),
  closedById: text("closed_by_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  initialReadingId: text("initial_reading_id").notNull().references(() => inventoryReadings.id),
  closingReadingId: text("closing_reading_id").references(() => inventoryReadings.id),
  // 0007: una lectura de apertura solo puede confirmarse una vez. Es el id de
  // esa lectura; el índice único parcial (WHERE confirm_key IS NOT NULL)
  // mantiene NULL en los cierres históricos, sin borrarlos.
  confirmKey: text("confirm_key"),
  periodStart: integer("period_start", { mode: "timestamp" }).notNull(),
  periodEnd: integer("period_end", { mode: "timestamp" }).notNull(),
  totalSales: integer("total_sales").notNull().default(0),
  totalIncome: real("total_income").notNull().default(0),
  incomeEfectivo: real("income_efectivo").notNull().default(0),
  incomeTransferencia: real("income_transferencia").notNull().default(0),
  items: text("items", { mode: "json" }).notNull().$defaultFn(() => []),
  notes: text("notes"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const auditLogs = sqliteTable("audit_logs", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  entity: text("entity").notNull(),
  entityId: text("entity_id"),
  detail: text("detail"),
  ip: text("ip"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const refreshTokens = sqliteTable("refresh_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  // Columna legacy (NOT NULL por el esquema 0001): desde 0007 el refresh token
  // se guarda hasheado en `tokenHash` y aquí va un marcador "sha256:<hash>".
  // Solo las filas anteriores a 0007 conservan el token en crudo.
  token: text("token").notNull(),
  tokenHash: text("token_hash"),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  // Sesión larga y rotante: cada refresh marca esta fila (rotatedAt) y crea
  // otra con expiración nueva. revokedAt es el fin de la ventana de gracia del
  // token sustituido; el logout lo revoca de inmediato (rotatedAt = null).
  rotatedAt: integer("rotated_at", { mode: "timestamp" }),
  rotatedToHash: text("rotated_to_hash"),
  revokedAt: integer("revoked_at", { mode: "timestamp" }),
  lastUsedAt: integer("last_used_at", { mode: "timestamp" }),
  deviceLabel: text("device_label"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  hashIdx: index("refresh_tokens_hash_idx").on(table.tokenHash),
  userIdx: index("refresh_tokens_user_idx").on(table.userId),
}));

// Tokens de un solo uso para "establecer contraseña" (cuenta nueva) y
// "olvidé mi contraseña" (cuenta existente) — ambos usan el mismo mecanismo:
// se genera un token aleatorio, se manda por correo, y el usuario elige su
// propia contraseña sin que admin (ni nadie más) la vea ni la escriba nunca.
// Guardamos el HASH del token, nunca el token en sí — igual que una
// contraseña, para que una fuga de la base de datos no sirva para nada.
export const passwordTokens = sqliteTable("password_tokens", {
  id: text("id").primaryKey(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  purpose: text("purpose", { enum: ["set_password", "forgot_password"] }).notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  usedAt: integer("used_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  userIdx: index("password_tokens_user_idx").on(table.userId),
  tokenHashIdx: uniqueIndex("password_tokens_hash_idx").on(table.tokenHash),
}));

// Tabla de contadores atómicos:
// - Números de factura correlativos por empresa/año: "invoice:{companyId}:{year}"
// - Rate limiting de login por IP: "ratelimit:{ip}:{ventana}"
export const counters = sqliteTable("counters", {
  id: text("id").primaryKey(),
  value: integer("value").notNull().default(0),
});

// ── Descuentos (solo admin crea/elimina) ────────────────────────────────────
// scope: "producto" → se aplica a una línea del carrito;
//        "venta"     → se aplica al total de la venta.
// type:  "porcentaje" (value = %) | "fijo" (value = monto en la moneda de la venta).
// locationScope: "todas" | "seleccion" (con locationIds).
export const discounts = sqliteTable("discounts", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"),
  scope: text("scope", { enum: ["producto", "venta"] }).notNull(),
  type: text("type", { enum: ["porcentaje", "fijo"] }).notNull(),
  value: real("value").notNull(),
  maxUses: integer("max_uses"),            // NULL = ilimitado
  timesUsed: integer("times_used").notNull().default(0),
  locationScope: text("location_scope", { enum: ["todas", "seleccion"] }).notNull().default("todas"),
  locationIds: text("location_ids", { mode: "json" }).notNull().$defaultFn(() => []),
  startsAt: integer("starts_at", { mode: "timestamp" }),
  endsAt: integer("ends_at", { mode: "timestamp" }),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdBy: text("created_by").references(() => users.id, { onDelete: "set null" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("discounts_company_idx").on(table.companyId),
}));

// ── Configuración de empresa: monedas operadas + modo de tasa de cambio ────
// currencies: lista de monedas que la empresa opera (mínimo 1, por defecto CUP).
// rateMode: "manual" (admin fija la tasa) | "eltoque" (se sincroniza desde
// el API pública de elToque y se cachea en este registro — nunca se le
// pregunta a elToque en cada venta: la app lee siempre de nuestra DB).
export const companySettings = sqliteTable("company_settings", {
  companyId: text("company_id").primaryKey().references(() => companies.id, { onDelete: "cascade" }),
  currencies: text("currencies", { mode: "json" }).notNull().$defaultFn(() => ["CUP"]),
  rateMode: text("rate_mode", { enum: ["manual", "eltoque"] }).notNull().default("manual"),
  manualRates: text("manual_rates", { mode: "json" }).notNull().$defaultFn(() => ({})),
  elToqueRates: text("eltoque_rates", { mode: "json" }).notNull().$defaultFn(() => ({})),
  elToqueUpdatedAt: integer("eltoque_updated_at", { mode: "timestamp" }),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// ── Programa de referidos ───────────────────────────────────────────────────
// Cada empresa tiene un código único (companies.referralCode). Cuando una
// empresa nueva se registra usando ese código y luego contrata un plan pago,
// la empresa referente recibe EL MISMO PLAN de regalo 30 días (una vez por
// cada referido que pague; referidos distintos se acumulan).
export const referrals = sqliteTable("referrals", {
  id: text("id").primaryKey(),
  referrerCompanyId: text("referrer_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  referredCompanyId: text("referred_company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  status: text("status", { enum: ["pendiente", "bonificado"] }).notNull().default("pendiente"),
  bonusPlan: text("bonus_plan"),
  bonusUntil: integer("bonus_until", { mode: "timestamp" }),
  bonifiedAt: integer("bonified_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  referrerIdx: index("referrals_referrer_idx").on(table.referrerCompanyId),
  referredIdx: uniqueIndex("referrals_referred_idx").on(table.referredCompanyId),
}));
