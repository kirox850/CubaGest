#!/usr/bin/env node
// Copia de seguridad de la base de datos de D1.
//
//   node scripts/backup.mjs                 → guarda ./backups/cubagest-<fecha>.sql
//   node scripts/backup.mjs --keep 14       → además, borra las más viejas de 14 días
//
// NO sube nada a ningún sitio: deja el .sql en la carpeta ./backups, que está
// en el .gitignore (es un archivo con los datos de todos los clientes).
//
// CÓMO DEJARLO CORRIENDO:
//  1. cd CubaGest
//  2. npm ci   (una sola vez)
//  3. Ejecuta a diario con cron de verdad:
//       crontab -e
//       0 3 * * * cd /ruta/al/CubaGest && /usr/bin/node scripts/backup.mjs --keep 14 >> /tmp/cubagest-backup.log 2>&1
//     (3:00 de la mañana, hora de Cuba). La máquina tiene que estar encendida;
//     si es elportátil que usas, esto no sirve y hay que hacerlo desde otro lado.
//  4. Copia el .sql a otro sitio (Drive, un disco externo). Un backup que vive
//     en el mismo disco que la app no es un backup.
//
// Si prefieres que las copias vivan en la nube, lo natural es un bucket de R2
// (el mismo Cloudflare): pídeme que lo monte y lo subo con `wrangler r2 put`.

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..");
const outDir = join(repoRoot, "backups");

const args = process.argv.slice(2);
const keepIdx = args.indexOf("--keep");
const KEEP_DAYS = keepIdx >= 0 ? Number(args[keepIdx + 1] || 14) : 30;

const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const outFile = join(outDir, `cubagest-${stamp}.sql`);

if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

console.log(`Generando copia de seguridad…`);
console.log(`  destino: ${outFile}`);

try {
  // El propio wrangler pide confirmación si ya existe el archivo; como el
  // nombre lleva fecha y hora, no debería pasar nunca.
  execFileSync("npx", ["wrangler", "d1", "export", "cubagest-db", "--remote", "--output", outFile], {
    cwd: repoRoot,
    stdio: "inherit",
  });
} catch (err) {
  console.error("\nLa copia FALLÓ. Revisa el mensaje de arriba.");
  console.error("Lo más probable: sin conexión, o sesión de Cloudflare no iniciada (`npx wrangler whoami`).");
  process.exit(1);
}

const size = existsSync(outFile) ? (statSync(outFile).size / 1024 / 1024).toFixed(2) : "?";
console.log(`\n✓ Copia creada (${size} MB)`);

// Limpieza de las viejas
const files = readdirSync(outDir).filter((f) => f.startsWith("cubagest-") && f.endsWith(".sql"));
const cutoff = Date.now() - KEEP_DAYS * 86400 * 1000;
let borradas = 0;
for (const f of files) {
  const full = join(outDir, f);
  if (statSync(full).getTime() < cutoff) {
    unlinkSync(full);
    borradas++;
  }
}
console.log(`Copias conservadas: ${files.length - borradas} (${KEEP_DAYS} días). Borradas hoy: ${borradas}.`);
console.log(`\nRecuerda: ${outDir} está en el .gitignore, pero la copia sigue siendo TU y de TUS clientes. Guárdala también fuera de esta máquina.`);
