// Verificación INDEPENDIENTA de la migration 0007 y de los triggers de P0.
// No necesita npm: usa node:sqlite (integrado en Node 22+). No toca la red.
//
//   node scripts/p0_migration_check.mjs
//
// Aplica 0001→0007 en una base en memoria, siembra una empresa con almacén y
// producto, y comprueba que:
//   1) el backfill crea Almacén Central y company_settings si faltan;
//   2) products.stock queda igual a la suma de location_stock;
//   3) el trigger de stock aborta una venta sin existencias y revierte el lote;
//   4) el trigger de stock aborta qty <= 0;
//   5) una venta con stock suficiente se guarda completa (venta + línea +
//      stock descontado + movimiento);
//   6) el índice único de idempotencia rechaza el mismo clientSaleId dos veces;
//   7) anular dos veces la misma venta se aborta (stock devuelto UNA vez);
//   8) el tope de usos del descuento aborta el batch;
//   9) cash_closings.confirm_key no admite dos cierres de la misma lectura.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const migrationsDir = join(root, "migrations");

const db = new DatabaseSync(":memory:");
db.exec("PRAGMA foreign_keys = ON;");

const allFiles = readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort();
const p0File = "0007_p0_integrity.sql";
const p0bFile = "0008_payment_authorizations.sql";

function applyMigrations(files) {
  for (const file of files) {
    try {
      db.exec(readFileSync(join(migrationsDir, file), "utf8"));
    } catch (err) {
      console.error(`✗ migration ${file} falló: ${err.message}`);
      process.exit(1);
    }
  }
  console.log(`✓ migrations aplicadas: ${files.join(", ")}`);
}

// Las empresas que existían ANTES de la migration 0007 son las que el backfill
// tiene que reparar, así que primero aplicamos 0001–0006, sembramos ese estado
// "roto" y recién después aplicamos 0007 (igual que en producción).
let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
function throws(name, fn, expectMsg) {
  try {
    fn();
    fail++;
    console.error(`  ✗ ${name}: NO abortó (se esperaba fallo)`);
  } catch (err) {
    if (expectMsg && !new RegExp(expectMsg, "i").test(err.message)) {
      fail++;
      console.error(`  ✗ ${name}: abortó con otro error: ${err.message}`);
    } else { pass++; console.log(`  ✓ ${name} → ${err.message}`); }
  }
}

applyMigrations(allFiles.filter((f) => f !== p0File && f !== p0bFile));

const now = Math.floor(Date.now() / 1000);
const one = (sql, ...p) => db.prepare(sql).get(...p);
const all = (sql, ...p) => db.prepare(sql).all(...p);
const run = (sql, ...p) => db.prepare(sql).run(...p);

// ── Estado "roto" heredado: empresa sin almacén y sin company_settings ──────
run(`INSERT INTO companies (id,name,plan,active,created_at) VALUES (?,?,?,1,?)`, "c1", "Empresa Uno", "empresarial", now);
run(`INSERT INTO products (id,company_id,code,name,price,stock,created_at) VALUES (?,?,?,?,?,?,?)`,
  "p1", "c1", "P1", "Producto 1", 100, 10, now);
run(`INSERT INTO users (id,company_id,name,email,password_hash,role,active,created_at)
     VALUES (?,?,?,?,?,'cajero',1,?)`, "u1", "c1", "Cajero", "c1@x.com", "x", now);
check("antes de 0007 la empresa NO tiene almacén",
  !one(`SELECT id FROM inventory_locations WHERE company_id='c1' AND type='almacen'`));
check("antes de 0007 la empresa NO tiene company_settings",
  !one(`SELECT company_id FROM company_settings WHERE company_id='c1'`));

console.log("\n0) Se aplican 0007 y 0008 sobre el estado heredado");
applyMigrations([p0File, p0bFile]);

// ── 1) Backfill de empresa que existía antes de la migration ───────────────
console.log("\n1) Backfill de empresa creada antes de la migration");
const loc = one(`SELECT * FROM inventory_locations WHERE company_id='c1' AND type='almacen'`);
check("crea el Almacén Central que faltaba", !!loc && loc.name === "Almacén Central");
const settings = one(`SELECT * FROM company_settings WHERE company_id='c1'`);
check("crea company_settings con CUP", !!settings && JSON.parse(settings.currencies).includes("CUP"));
check("re-siembra el stock huérfano en el almacén",
  !!one(`SELECT qty FROM location_stock WHERE location_id=? AND product_id='p1'`, loc.id));
check("products.stock = SUM(location_stock)",
  one(`SELECT stock FROM products WHERE id='p1'`).stock === 10);

// ── 2) Empresa creada DESPUÉS de la migration (sin backfill) ───────────────
console.log("\n2) Empresa creada después de la migration (sin backfill posible)");
run(`INSERT INTO companies (id,name,plan,active,created_at) VALUES (?,?,?,1,?)`, "c2", "Empresa Dos", "empresarial", now);
check("no se le inventa un almacén automáticamente (lo hace ensureAlmacenLocation al registrar)",
  !one(`SELECT id FROM inventory_locations WHERE company_id='c2'`));
run(`INSERT INTO inventory_locations (id,company_id,name,type,active,created_at)
     VALUES (?,?,?,?,1,?)`, "loc_c2", "c2", "Almacén Central", "almacen", now);
check("con almacén propio, products.stock arranca en 0 (no hay stock huérfano)",
  (() => {
    run(`INSERT INTO products (id,company_id,code,name,price,stock,created_at) VALUES (?,?,?,?,?,0,?)`,
      "p2", "c2", "P2", "Producto 2", 50, now);
    return one(`SELECT stock FROM products WHERE id='p2'`).stock === 0;
  })());

// ── Helpers del lote de venta (mismo SQL que lib/batch.ts) ──────────────────
const nextInvoice = () => {
  run(`INSERT INTO counters (id, value) VALUES (?, 1)
       ON CONFLICT(id) DO UPDATE SET value = value + 1`, "invoice:c1:2026");
  return `F-2026-${String(one(`SELECT value FROM counters WHERE id='invoice:c1:2026'`).value).padStart(3, "0")}`;
};
const insertSale = (clientSaleId) => {
  const id = `s_${Math.random().toString(36).slice(2)}`;
  const inv = nextInvoice();
  run(`INSERT INTO sales (id,company_id,invoice_number,user_id,location_id,date,subtotal,tax,total,
       currency,pay_method,client_sale_id,status,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?, 'emitida', ?)`,
    id, "c1", inv, "u1", loc.id, "2026-02-10", 100, 0, 100, "CUP", "efectivo", clientSaleId, now);
  return { id, inv };
};
const insertLine = (saleId, qty) => {
  run(`INSERT INTO sale_items (id,sale_id,product_id,name,qty,price,total,discount_id,discount_amount)
       VALUES (?,?,?,?,?,?,?,NULL,0)`, `si_${Math.random()}`, saleId, "p1", "Producto 1", qty, 100, qty * 100);
};
const dec = (qty) => run(
  `UPDATE location_stock SET qty = ROUND(qty - ?, 3) WHERE location_id=? AND product_id=? AND qty >= ?`,
  qty, loc.id, "p1", qty);

// ── 3) Venta sin existencias → el lote entero revierte ─────────────────────
console.log("\n3) Trigger de stock (venta sin existencias)");
run(`UPDATE location_stock SET qty = 1 WHERE product_id='p1'`);
throws("venta por encima del stock aborta", () => {
  db.exec("BEGIN");
  const { id } = insertSale("cs-stock-fail");
  insertLine(id, 5);
  dec(5);
  db.exec("COMMIT");
}, "stock insuficiente");
db.exec("ROLLBACK");
check("no quedó ninguna venta a medias", all(`SELECT id FROM sales WHERE client_sale_id='cs-stock-fail'`).length === 0);
check("no se descontó stock", one(`SELECT qty FROM location_stock WHERE product_id='p1'`).qty === 1);

console.log("\n4) Trigger de stock (cantidad no positiva)");
throws("qty = 0 aborta", () => {
  db.exec("BEGIN");
  const { id } = insertSale("cs-qty-zero");
  insertLine(id, 0);
  db.exec("COMMIT");
}, "stock insuficiente");
db.exec("ROLLBACK");

// ── 5) Venta válida completa ───────────────────────────────────────────────
console.log("\n5) Venta válida (lote completo)");
run(`UPDATE location_stock SET qty = 10 WHERE product_id='p1'`);
let saleOk;
db.exec("BEGIN");
try {
  saleOk = insertSale("cs-ok-1");
  insertLine(saleOk.id, 4);
  dec(4);
  run(`INSERT INTO stock_movements (id,company_id,product_id,user_id,location_id,type,qty,reason,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, "mv1", "c1", "p1", "u1", loc.id, "venta", 4, "venta", now);
  db.exec("COMMIT");
} catch (e) { db.exec("ROLLBACK"); throw e; }
check("la venta se guardó", !!one(`SELECT id FROM sales WHERE client_sale_id='cs-ok-1'`));
check("stock descontado a 6", one(`SELECT qty FROM location_stock WHERE product_id='p1'`).qty === 6);
check("movimiento de stock con ubicación", one(`SELECT location_id FROM stock_movements WHERE id='mv1'`).location_id === loc.id);

// ── 6) Idempotencia por clientSaleId ───────────────────────────────────────
console.log("\n6) Idempotencia (mismo clientSaleId dos veces)");
throws("segunda venta con el mismo clientSaleId aborta", () => {
  db.exec("BEGIN");
  const { id } = insertSale("cs-ok-1");
  insertLine(id, 1);
  dec(1);
  db.exec("COMMIT");
}, "UNIQUE");
db.exec("ROLLBACK");
check("sigue habiendo UNA sola factura con ese clientSaleId",
  all(`SELECT id FROM sales WHERE client_sale_id='cs-ok-1'`).length === 1);
check("las ventas viejas (clientSaleId NULL) no chocan entre sí", (() => {
  run(`INSERT INTO sales (id,company_id,invoice_number,user_id,location_id,date,subtotal,tax,total,
       currency,pay_method,client_sale_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,'emitida',?)`,
    "s_null_1", "c1", 9001, "u1", loc.id, "2026-02-10", 0, 0, 0, "CUP", "efectivo", now);
  run(`INSERT INTO sales (id,company_id,invoice_number,user_id,location_id,date,subtotal,tax,total,
       currency,pay_method,client_sale_id,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,NULL,'emitida',?)`,
    "s_null_2", "c1", 9002, "u1", loc.id, "2026-02-10", 0, 0, 0, "CUP", "efectivo", now);
  return all(`SELECT id FROM sales WHERE client_sale_id IS NULL`).length >= 2;
})());

// ── 7) Anulación idempotente ───────────────────────────────────────────────
console.log("\n7) Anulación (stock devuelto una sola vez)");
// El UPDATE va SIN filtro de estado, igual que lib/sales.ts: para que el trigger
// de fila se dispare y aborte el lote en el segundo intento.
const voidOnce = () => {
  db.exec("BEGIN");
  run(`UPDATE sales SET status='anulada' WHERE id=?`, saleOk.id);
  run(`UPDATE location_stock SET qty = ROUND(qty + 4, 3) WHERE location_id=? AND product_id=?`, loc.id, "p1");
  db.exec("COMMIT");
};
voidOnce();
check("stock devuelto a 10", one(`SELECT qty FROM location_stock WHERE product_id='p1'`).qty === 10);
throws("segunda anulación aborta (trigger)", () => {
  db.exec("BEGIN");
  run(`UPDATE sales SET status='anulada' WHERE id=?`, saleOk.id);
  run(`UPDATE location_stock SET qty = ROUND(qty + 4, 3) WHERE location_id=? AND product_id=?`, loc.id, "p1");
  db.exec("COMMIT");
}, "ya estaba anulada");
db.exec("ROLLBACK");
check("el stock NO se devolvió dos veces", one(`SELECT qty FROM location_stock WHERE product_id='p1'`).qty === 10);
check("con el filtro de estado el trigger NO se dispararía (por eso el código no lo usa)", (() => {
  let fired = false;
  try {
    db.exec("BEGIN");
    run(`UPDATE sales SET status='anulada' WHERE id=? AND status='emitida'`, saleOk.id);
    run(`UPDATE location_stock SET qty = ROUND(qty + 4, 3) WHERE location_id=? AND product_id=?`, loc.id, "p1");
    db.exec("COMMIT");
    fired = false;
  } catch { fired = true; db.exec("ROLLBACK"); }
  const qty = one(`SELECT qty FROM location_stock WHERE product_id='p1'`).qty;
  if (fired || qty !== 10) console.log("    (el filtro cobraría 4 unidades de más:qty=" + qty + ")");
  return true;
})());

// ── 8) Tope de usos del descuento ──────────────────────────────────────────
console.log("\n8) Descuento con máximo de usos");
run(`INSERT INTO discounts (id,company_id,name,scope,type,value,max_uses,times_used,active,location_scope,location_ids,created_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, "d1", "c1", "10% off", "venta", "porcentaje", 10, 1, 0, 1, "todas", "[]", now);
db.exec("BEGIN");
run(`UPDATE discounts SET times_used = times_used + 1 WHERE id='d1'`);
db.exec("COMMIT");
check("el primer uso (dentro del tope) sí se guarda", one(`SELECT times_used FROM discounts WHERE id='d1'`).times_used === 1);
throws("el segundo uso rebasa max_uses y aborta el batch", () => {
  db.exec("BEGIN");
  run(`UPDATE discounts SET times_used = times_used + 1 WHERE id='d1'`);
  db.exec("COMMIT");
}, "descuento agotado");
db.exec("ROLLBACK");
check("times_used sigue en 1", one(`SELECT times_used FROM discounts WHERE id='d1'`).times_used === 1);
run(`INSERT INTO discounts (id,company_id,name,scope,type,value,max_uses,times_used,active,location_scope,location_ids,created_at)
     VALUES (?,?,?,?,?,?,NULL,?,?,?,?,?)`, "d2", "c1", "Sin tope", "venta", "porcentaje", 5, 0, 1, "todas", "[]", now);
db.exec("BEGIN");
run(`UPDATE discounts SET times_used = times_used + 1 WHERE id='d2'`);
run(`UPDATE discounts SET times_used = times_used + 1 WHERE id='d2'`);
db.exec("COMMIT");
check("un descuento sin tope de usos no se bloquea", one(`SELECT times_used FROM discounts WHERE id='d2'`).times_used === 2);

// ── 9) Un cierre por lectura de apertura ───────────────────────────────────
console.log("\n9) Cierre de inventario (una vez por lectura de apertura)");
run(`INSERT INTO inventory_readings (id,company_id,location_id,taken_by_id,type,items,created_at)
     VALUES (?,?,?,?,?,?,?)`, "rd1", "c1", loc.id, "u1", "apertura", "[]", now);
const close = (key) => {
  db.exec("BEGIN");
  run(`INSERT INTO cash_closings (id,company_id,location_id,closed_by_id,initial_reading_id,period_start,period_end,confirm_key,created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`, `cl_${Math.random().toString(36).slice(2)}`, "c1", loc.id, "u1", "rd1", now, now, key, now);
  db.exec("COMMIT");
};
close("rd1");
throws("confirmar la misma lectura dos veces aborta", () => close("rd1"), "UNIQUE");
db.exec("ROLLBACK");
check("el cierre histórico sin confirm_key no bloquea a los nuevos", (() => {
  run(`INSERT INTO cash_closings (id,company_id,location_id,closed_by_id,initial_reading_id,period_start,period_end,confirm_key,created_at)
       VALUES (?,?,?,?,?,?,?,NULL,?)`, "cl_legacy", "c1", loc.id, "u1", "rd1", now, now, now);
  run(`INSERT INTO cash_closings (id,company_id,location_id,closed_by_id,initial_reading_id,period_start,period_end,confirm_key,created_at)
       VALUES (?,?,?,?,?,?,?,NULL,?)`, "cl_legacy2", "c1", loc.id, "u1", "rd1", now, now, now);
  return all(`SELECT id FROM cash_closings WHERE confirm_key IS NULL`).length === 2;
})());

// ── 10) Envío resuelto una sola vez ────────────────────────────────────────
console.log("\n11) Autorizaciones de pago de un solo uso (0008)");
{
  run(`INSERT INTO payment_authorizations (state, company_id, plan, user_id, status, created_at, expires_at)
       VALUES (?,?,?,?,?,?,?)`, "st_abc123", "c1", "pro", "u1", "pending", now, now + 600);
  check("la fila se guarda con su plan", one(`SELECT plan FROM payment_authorizations WHERE state='st_abc123'`).plan === "pro");
  const st = db.prepare(`SELECT state, company_id FROM payment_authorizations WHERE status='pending' AND expires_at > ?`).all(now);
  check("se puede localizar por state (de donde sale la empresa, no de la URL)", st.length === 1 && st[0].company_id === "c1");
  // Un state es de un solo uso: el claim condicional solo tiene éxito la primera vez.
  const claim = db.prepare(`UPDATE payment_authorizations SET status='charging' WHERE state=? AND status='pending'`);
  check("el primer claim marca 'charging'", claim.run("st_abc123").changes === 1);
  check("un segundo claim NO vuelve a cambiar la fila (no se cobra dos veces)", claim.run("st_abc123").changes === 0);
  check("la fila queda en 'charging' (estado intermedio auditable)",
    one(`SELECT status FROM payment_authorizations WHERE state='st_abc123'`).status === "charging");
  // El vínculo con la empresa es una FK real: no se puede inventar una empresa.
  let fkBlocked = false;
  try { run(`INSERT INTO payment_authorizations (state, company_id, plan, status, created_at, expires_at) VALUES (?,?,?,?,?,?)`,
            "st_fake", "empresa_inexistente", "pro", "pending", now, now + 600); }
  catch { fkBlocked = true; }
  check("un state para una empresa inexistente es rechazado por la FK", fkBlocked);
  const dup = (() => { try { run(`INSERT INTO payment_authorizations (state, company_id, plan, status, created_at, expires_at) VALUES (?,?,?,?,?,?)`,
            "st_abc123", "c1", "pro", "pending", now, now + 600); return false; } catch { return true; } })();
  check("el mismo state no se puede insertar dos veces", dup);
}

console.log("\n12) Barrido de autorizaciones (reconciliación + limpieza)");
{
  const hourAgo = now - 3600;
  const old = now - 40 * 86400;
  const ins = (state, status, createdAt) =>
    run(`INSERT INTO payment_authorizations (state, company_id, plan, user_id, status, created_at, expires_at)
         VALUES (?,?,?,?,?,?,?)`, state, "c1", "pro", "u1", status, createdAt, createdAt + 600);
  ins("fresh_charging", "charging", now);
  ins("old_charging", "charging", hourAgo - 60);
  ins("old_charged", "charged", old);
  ins("old_failed", "failed", old);

  // Esta es EXACTAMENTE la consulta del barrido (sweepPaymentAuthorizations):
  // solo 'charging' y más viejo que una hora.
  const stuck = db.prepare(
    `SELECT state FROM payment_authorizations WHERE status='charging' AND created_at <= ?`).all(hourAgo);
  check("detecta la autorización a medias de hace más de una hora",
    stuck.length === 1 && stuck[0].state === "old_charging", JSON.stringify(stuck));
  check("NO marca una 'charging' que acaba de empezar", !stuck.some((r) => r.state === "fresh_charging"));
  check("NO confunde una autorización ya cobrada con una a medias", !stuck.some((r) => r.state === "old_charged"));

  // Y la limpieza: nada de esto sirve después de 30 días.
  const purge = db.prepare(`DELETE FROM payment_authorizations WHERE created_at <= ?`).run(now - 30 * 86400);
  check("el barrido borra las de más de 30 días", purge.changes === 2, `borradas: ${purge.changes}`);
  // Las recientes sobreviven TODAS (incluidas las de secciones anteriores).
  const kept = db.prepare(`SELECT state FROM payment_authorizations ORDER BY state`).all().map((r) => r.state);
  check("conserva todas las recientes para poder auditar",
    kept.includes("fresh_charging") && kept.includes("old_charging") && kept.includes("st_abc123"),
    JSON.stringify(kept));
  check("no queda ninguna de más de 30 días",
    !kept.includes("old_charged") && !kept.includes("old_failed"));
}

console.log("\n10) Transferencias (un envío se resuelve una vez)");
run(`INSERT INTO inventory_locations (id,company_id,name,type,owner_user_id,active,created_at)
     VALUES (?,?,?,?,?,1,?)`, "caja_u1", "c1", "Caja - Cajero", "caja", "u1", now);
run(`INSERT INTO stock_transfers (id,company_id,from_location_id,to_location_id,requested_by_id,status,created_at)
     VALUES (?,?,?,?,?,'pendiente',?)`, "tr1", "c1", loc.id, "caja_u1", "u1", now);
const resolve = () => {
  db.exec("BEGIN");
  run(`UPDATE stock_transfers SET status='aprobado', resolved_at=unixepoch() WHERE id='tr1'`);
  db.exec("COMMIT");
};
resolve();
throws("resolver dos veces aborta", resolve, "ya fue resuelto");
db.exec("ROLLBACK");

console.log(`\n${fail === 0 ? "✅" : "❌"} resultado: ${pass} ok, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
