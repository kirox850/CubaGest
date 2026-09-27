import { Hono } from "hono";
// ─── SALUD DE LA BASE DE DATOS ──────────────────────────────────────────────
//
// Existe por un motivo muy concreto: cuando se despliega el Worker y se olvida
// aplicar la migración, la aplicación se rompe de formas que no apuntan a la
// causa. El POS vacío dice "no hay productos", el inventario no carga, y nadie
// sospecha de una migración que nadie ejecutó.
//
// Esta ruta responde una sola pregunta, sin login y sin decir nada del negocio:
// ¿están las tablas que el código espera? Con eso se pierde en diez segundos
// lo que antes costaba media hora de pensar.

const REQUERIDAS = [
  { tabla: "inventory_locations", desde: "0003" },
  { tabla: "location_assignments", desde: "0012" },
  { tabla: "shifts", desde: "0012" },
  { tabla: "cash_movements", desde: "0013" },
  { tabla: "closing_explanations", desde: "0013" },
  { tabla: "closing_notes", desde: "0014" },
];

const health = new Hono<{ Bindings: Env }>();

health.get("/db", async (c) => {
  // Se consulta D1 directo con SQL: el punto de esta ruta es comprobar si las
  // tablas existen, así que no puede pasar por Drizzle, que construye la
  // consulta a partir del esquema y fallaría justo en lo que queremos medir.
  const db = c.env.DB;
  const faltan: string[] = [];
  for (const { tabla, desde } of REQUERIDAS) {
    try {
      await db.prepare(`SELECT 1 FROM ${tabla} LIMIT 1`).first();
    } catch {
      faltan.push(`${tabla} (migración ${desde})`);
    }
  }
  // Se devuelven los NOMBRES de las tablas que faltan. Es información sobre
  // la instalación, no sobre ningún cliente: no hay ni una fila de negocio.
  return c.json({
    ok: faltan.length === 0,
    listo: faltan.length === 0,
    faltan,
    mensaje: faltan.length === 0
      ? "La base de datos está al día."
      : `Faltan tablas. Aplica las migraciones de D1: npx wrangler d1 migrations apply cubagest-db --remote. Missing: ${faltan.join(", ")}`,
  });
});

export default health;
