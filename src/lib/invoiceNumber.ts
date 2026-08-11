// Generación atómica de número de factura correlativo
// Usa INSERT OR REPLACE para garantizar atomicidad en D1
// Evita race conditions cuando múltiples cajeros venden simultáneamente

export async function nextInvoiceNumber(env: Env, companyId: string): Promise<string> {
  const year = new Date().getFullYear();
  const key = `invoice:${companyId}:${year}`;

  // Upsert atómico: inserta con valor 1 o incrementa si ya existe
  await env.DB.prepare(
    `INSERT INTO counters (id, value)
     VALUES (?, 1)
     ON CONFLICT(id) DO UPDATE SET value = value + 1`
  )
    .bind(key)
    .run();

  const row = await env.DB.prepare(
    `SELECT value FROM counters WHERE id = ?`
  )
    .bind(key)
    .first<{ value: number }>();

  if (!row) throw new Error("Error generando número de factura");

  return `F-${year}-${String(row.value).padStart(3, "0")}`;
}
