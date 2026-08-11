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
  qvapayAuthorized: integer("qvapay_authorized", { mode: "boolean" }).notNull().default(false),
  lastPaymentDate: integer("last_payment_date", { mode: "timestamp" }),
  nextPaymentDate: integer("next_payment_date", { mode: "timestamp" }),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

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
  name: text("name").notNull(),
  category: text("category").notNull().default("Otros"),
  unit: text("unit").notNull().default("ud"),
  price: real("price").notNull(),
  cost: real("cost").notNull().default(0),
  stock: real("stock").notNull().default(0),
  minStock: real("min_stock").notNull().default(0),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
  updatedAt: integer("updated_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("products_company_idx").on(table.companyId),
  codeIdx: uniqueIndex("products_code_idx").on(table.companyId, table.code),
}));

export const sales = sqliteTable("sales", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  invoiceNumber: text("invoice_number").notNull(),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "set null" }),
  date: text("date").notNull(),
  clientName: text("client_name").notNull().default("Consumidor Final"),
  clientNit: text("client_nit"),
  clientPhone: text("client_phone"),
  subtotal: real("subtotal").notNull(),
  tax: real("tax").notNull().default(0),
  total: real("total").notNull(),
  currency: text("currency", { enum: ["CUP", "MLC", "USD"] }).notNull().default("CUP"),
  payMethod: text("pay_method", { enum: ["efectivo", "mlc", "transferencia", "tarjeta"] }).notNull(),
  status: text("status", { enum: ["emitida", "anulada"] }).notNull().default("emitida"),
  syncedAt: integer("synced_at", { mode: "timestamp" }),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("sales_company_idx").on(table.companyId),
  invoiceIdx: uniqueIndex("sales_invoice_idx").on(table.companyId, table.invoiceNumber),
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
  type: text("type", { enum: ["entrada", "salida", "venta", "ajuste"] }).notNull(),
  qty: real("qty").notNull(),
  reason: text("reason"),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
}, (table) => ({
  companyIdx: index("sm_company_idx").on(table.companyId),
  productIdx: index("sm_product_idx").on(table.productId),
}));

export const inventoryReadings = sqliteTable("inventory_readings", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  takenById: text("taken_by_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: text("type", { enum: ["apertura", "cierre"] }).notNull(),
  notes: text("notes"),
  items: text("items", { mode: "json" }).notNull().$defaultFn(() => []),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

export const cashClosings = sqliteTable("cash_closings", {
  id: text("id").primaryKey(),
  companyId: text("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
  closedById: text("closed_by_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  initialReadingId: text("initial_reading_id").notNull().references(() => inventoryReadings.id),
  closingReadingId: text("closing_reading_id").references(() => inventoryReadings.id),
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
  token: text("token").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp" }).notNull(),
  createdAt: integer("created_at", { mode: "timestamp" }).$defaultFn(() => new Date()),
});

// Tabla de contadores atómicos:
// - Números de factura correlativos por empresa/año: "invoice:{companyId}:{year}"
// - Rate limiting de login por IP: "ratelimit:{ip}:{ventana}"
export const counters = sqliteTable("counters", {
  id: text("id").primaryKey(),
  value: integer("value").notNull().default(0),
});
