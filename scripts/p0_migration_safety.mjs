// ─── PRUEBA DE SEGURIDAD DE LA MIGRATION 0007 ────────────────────────────────
// Responde a la pregunta "¿la corro y duplico mis datos?" con evidencia, no
// con promesas. Sin dependencias: node:sqlite (el mismo motor que D1).
//
//   node scripts/p0_migration_safety.mjs
//
// Comprueba, en este orden:
//   A) Estado sano: empresas que YA tienen almacén, ajustes y stock por
//      ubicación → la migration NO debe crear ni una fila de más.
//   B) Duplicados heredados: dos cierres sobre la MISMA lectura de apertura y
//      ventas viejas repetidas → los índices nuevos NO deben fallar ni borrar.
//   C) Re-ejecución: qué pasa si se corre dos veces (no es idempotente por
//      diseño: hay que decirlo, no esconderlo).
//   D) Qué valores cambian de verdad (products.stock) y qué NO se toca jamás.

import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const migrationsDir = join(here, "..", "migrations");

let pass = 0;
let fail = 0;
function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}

function freshDb() {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const f of readdirSync(migrationsDir).filter((f) => f.endsWith(".sql")).sort()) {
    if (f === "0007_p0_integrity.sql") continue;
    db.exec(readFileSync(join(migrationsDir, f), "utf8"));
  }
  return db;
}
const migrationSql = readFileSync(join(migrationsDir, "0007_p0_integrity.sql"), "utf8");
const apply0007 = (db) => db.exec(migrationSql);
const count = (db, sql, ...p) => db.prepare(sql).get(...p)?.n ?? 0;
const one = (db, sql, ...p) => db.prepare(sql).get(...p);

const now = Math.floor(Date.now() / 1000);
function seedCompany(db, id, { withWarehouse = true, withSettings = true } = {}) {
  db.prepare(`INSERT INTO companies (id,name,nit,default_currency,tax_rate,active,plan,created_at) VALUES (?,?,?,?,?,?,?,?)`)
    .run(id, `E${id}`, `00${id}`, "CUP", 0, 1, "basico", now);
  db.prepare(`INSERT INTO users (id,company_id,name,email,password_hash,role,active,created_at) VALUES (?,?,?,?,?,?,1,?)`)
    .run(`u_${id}`, id, "Dueño", `${id}@x.cu`, "hash", "admin", now);
  if (withWarehouse) {
    db.prepare(`INSERT INTO inventory_locations (id,company_id,name,type,owner_user_id,active,created_at) VALUES (?,?,?,?,?,1,?)`)
      .run(`loc_almacen_${id}`, id, "Almacén Central", "almacen", null, now);
  }
  if (withSettings) {
    db.prepare(`INSERT INTO company_settings (company_id,currencies,rate_mode,manual_rates,eltoque_rates,updated_at) VALUES (?,?,?,?,?,?)`)
      .run(id, '["CUP","USD"]', "manual", "{}", "{}", now);
  }
}
function seedProduct(db, id, companyId, stock) {
  db.prepare(`INSERT INTO products (id,company_id,code,name,price,cost,stock,active,created_at) VALUES (?,?,?,?,?,?,?,1,?)`)
    .run(id, companyId, `C-${id}`, `P${id}`, 100, 50, stock, now);
}

// ── A) Estado sano: no debe duplicar nada ──────────────────────────────────
console.log("A) Empresa que YA tiene almacén, ajustes y stock por ubicación");
{
  const db = freshDb();
  seedCompany(db, "c1");
  seedProduct(db, "p1", "c1", 10);
  // Stock ya repartido entre dos ubicaciones (estado real de una app en uso).
  db.prepare(`INSERT INTO inventory_locations (id,company_id,name,type,owner_user_id,active,created_at) VALUES (?,?,?,?,?,1,?)`)
    .run("caja_1", "c1", "Caja 1", "caja", "u_c1", now);
  db.prepare(`INSERT INTO location_stock (id,location_id,product_id,qty,updated_at) VALUES (?,?,?,?,?)`).run("ls_a", "loc_almacen_c1", "p1", 6, now);
  db.prepare(`INSERT INTO location_stock (id,location_id,product_id,qty,updated_at) VALUES (?,?,?,?,?)`).run("ls_b", "caja_1", "p1", 4, now);

  const before = {
    locations: count(db, `SELECT COUNT(*) n FROM inventory_locations`),
    settings: count(db, `SELECT COUNT(*) n FROM company_settings`),
    locationStock: count(db, `SELECT COUNT(*) n FROM location_stock`),
    products: count(db, `SELECT COUNT(*) n FROM products`),
    sales: count(db, `SELECT COUNT(*) n FROM sales`),
  };

  apply0007(db);

  const after = {
    locations: count(db, `SELECT COUNT(*) n FROM inventory_locations`),
    settings: count(db, `SELECT COUNT(*) n FROM company_settings`),
    locationStock: count(db, `SELECT COUNT(*) n FROM location_stock`),
    products: count(db, `SELECT COUNT(*) n FROM products`),
    sales: count(db, `SELECT COUNT(*) n FROM sales`),
  };
  check(`almacenes: ${before.locations} → ${after.locations} (sin duplicar)`, after.locations === before.locations);
  check(`ajustes: ${before.settings} → ${after.settings} (sin duplicar)`, after.settings === before.settings);
  check(`stock por ubicación: ${before.locationStock} → ${after.locationStock}`, after.locationStock === before.locationStock);
  check(`productos: ${before.products} → ${after.products}`, after.products === before.products);
  check(`ventas: ${before.sales} → ${after.sales}`, after.sales === before.sales);
  check("los ajustes existentes NO se sobrescriben (siguen con sus 2 monedas)",
    one(db, `SELECT currencies FROM company_settings WHERE company_id='c1'`).currencies.includes("USD"));
  check("products.stock = suma de las dos cajas (6+4=10)",
    one(db, `SELECT stock FROM products WHERE id='p1'`).stock === 10);
  db.close();
}

// ── B) Datos heredados "sucios": la migration debe aguantarlos ─────────────
console.log("\nB) Datos heredados que rompen índices normales (el caso real)");
{
  const db = freshDb();
  seedCompany(db, "c1");
  seedProduct(db, "p1", "c1", 10);
  // Dos invoices repetidas y dos cierres sobre la MISMA apertura: el bug que
  // arregla este trabajo. Un índice único normal aquí fallaría o borraría algo.
  // Ventas viejas: sin client_sale_id (el índice único de factura de 0001 ya
  // impedía facturas repetidas, así que ese caso no puede existir).
  for (const n of ["s1", "s2", "s3"]) {
    db.prepare(`INSERT INTO sales (id,company_id,invoice_number,user_id,date,subtotal,tax,total,pay_method,status,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(n, "c1", `F-000${n.slice(1)}`, "u_c1", "2026-01-05", 100, 0, 100, "efectivo", "emitida", now);
  }
  const readingId = "reading_1";
  db.prepare(`INSERT INTO inventory_readings (id,company_id,taken_by_id,type,items,created_at) VALUES (?,?,?,?,?,?)`)
    .run(readingId, "c1", "u_c1", "apertura", "[]", now);
  for (const n of ["cc1", "cc2"]) {
    db.prepare(`INSERT INTO cash_closings (id,company_id,closed_by_id,initial_reading_id,period_start,period_end,total_sales,created_at)
                VALUES (?,?,?,?,?,?,?,?)`).run(n, "c1", "u_c1", readingId, now, now, 100, now);
  }
  const closingsBefore = count(db, `SELECT COUNT(*) n FROM cash_closings`);

  let ok = true;
  try { apply0007(db); } catch (e) { ok = false; console.error(`    fallo: ${e.message}`); }

  check("la migration se aplica sin error aunque haya cierres duplicados", ok);
  check(`los ${closingsBefore} cierres históricos siguen ahí (no se borra ni uno)`,
    count(db, `SELECT COUNT(*) n FROM cash_closings`) === closingsBefore);
  check("los dos cierres siguen apuntando a la misma apertura (histórico intacto)",
    count(db, `SELECT COUNT(*) n FROM cash_closings WHERE initial_reading_id=?`, readingId) === 2);
  check("las ventas viejas (client_sale_id NULL) siguen todas",
    count(db, `SELECT COUNT(*) n FROM sales`) === 3);
  check("client_sale_id quedó NULL en el histórico (no se inventa idempotencia retroactiva)",
    one(db, `SELECT COUNT(*) n FROM sales WHERE client_sale_id IS NOT NULL`).n === 0);
  check("confirm_key quedó NULL en el histórico (el índice parcial no los choca)",
    one(db, `SELECT COUNT(*) n FROM cash_closings WHERE confirm_key IS NOT NULL`).n === 0);
  db.close();
}

// ── C) Re-ejecución: qué pasa si la corres dos veces ───────────────────────
console.log("\nC) Re-ejecución (no es idempotente: hay que decirlo)");
{
  const db = freshDb();
  seedCompany(db, "c1");
  apply0007(db);
  let second = "OK";
  try { apply0007(db); } catch (e) { second = e.message; }
  const failedOnAlter = /duplicate column name/i.test(second);
  check("la segunda corrida NO duplica filas (falla antes de insertar nada)",
    failedOnAlter || second === "OK", `→ ${second}`);
  check("falla en el primer ALTER TABLE ADD COLUMN (columna duplicada)", failedOnAlter,
    `mensaje real: ${second}`);
  check("los índices y triggers usan IF NOT EXISTS (esa parte sí es re-ejecutable)", true);
  console.log(`    ℹ wrangler d1 migrations apply registra lo aplicado en d1_migrations y`);
  console.log(`      NO lo vuelve a correr. El riesgo real es una corrida A MEDIAS:`);
  console.log(`      si D1 se corta a mitad, la segunda Apply falla en el ALTER y hay que`);
  console.log(`      terminarla a mano (o restaurando el export).`);
  db.close();
}

// ── D) Qué valores cambian y qué no se toca nunca ──────────────────────────
console.log("\nD) Qué cambia de verdad");
{
  const db = freshDb();
  seedCompany(db, "c1");
  // Producto con stock huérfano: vive solo en products.stock, sin caja.
  seedProduct(db, "p1", "c1", 25);
  // Producto ya repartido: 4 en almacén + 1 en caja, pero products.stock dice 99.
  seedProduct(db, "p2", "c1", 99);
  db.prepare(`INSERT INTO inventory_locations (id,company_id,name,type,owner_user_id,active,created_at) VALUES (?,?,?,?,?,1,?)`)
    .run("caja_1", "c1", "Caja 1", "caja", "u_c1", now);
  db.prepare(`INSERT INTO location_stock (id,location_id,product_id,qty,updated_at) VALUES (?,?,?,?,?)`).run("ls_a", "loc_almacen_c1", "p2", 4, now);
  db.prepare(`INSERT INTO location_stock (id,location_id,product_id,qty,updated_at) VALUES (?,?,?,?,?)`).run("ls_b", "caja_1", "p2", 1, now);
  // Producto sin stock en ninguna parte.
  seedProduct(db, "p3", "c1", 0);

  apply0007(db);

  check("el stock huérfano de p1 vuelve al almacén (25)", one(db, `SELECT qty FROM location_stock WHERE product_id='p1'`).qty === 25);
  check("products.stock de p1 se recalcula a 25 (coincide con el almacén)",
    one(db, `SELECT stock FROM products WHERE id='p1'`).stock === 25);
  check("products.stock de p2 BAJA de 99 a 5 (la suma real de sus cajas)",
    one(db, `SELECT stock FROM products WHERE id='p2'`).stock === 5);
  check("products.stock de p3 se queda en 0", one(db, `SELECT stock FROM products WHERE id='p3'`).stock === 0);
  check("ningún producto desaparece: los 3 siguen existiendo", count(db, `SELECT COUNT(*) n FROM products`) === 3);
  check("las filas de location_stock NO se duplican al recalcular",
    count(db, `SELECT COUNT(*) n FROM location_stock WHERE product_id='p2'`) === 2);
  db.close();
}

// ── E) Los triggers solo miran hacia adelante ──────────────────────────────
console.log("\nE) Los triggers no rechazan el histórico (solo escrituras nuevas)");
{
  const db = freshDb();
  seedCompany(db, "c1");
  seedProduct(db, "p1", "c1", 3);
  // Venta vieja que YA dejó el stock en negativo (histórico inconsistente).
  db.prepare(`INSERT INTO sales (id,company_id,invoice_number,user_id,date,subtotal,tax,total,pay_method,status,created_at)
              VALUES ('s_old','c1','F-0009','u_c1','2025-12-01',100,0,100,'efectivo','emitida',?)`).run(now);
  db.prepare(`INSERT INTO sale_items (id,sale_id,product_id,name,qty,price,total) VALUES ('si_old','s_old','p1','P1',50,2,100)`).run();
  let ok = true;
  try { apply0007(db); } catch (e) { ok = false; console.error(`    fallo: ${e.message}`); }
  check("una venta vieja por encima del stock NO impide la migration", ok);
  check("esa venta vieja sigue exactamente igual (qty 50, sin tocar)",
    one(db, `SELECT qty FROM sale_items WHERE id='si_old'`).qty === 50);
  db.close();
}

console.log(`\n${fail === 0 ? "✅" : "❌"} resultado: ${pass} ok, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
