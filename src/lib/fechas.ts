// ─── INSTANTES: SEGUNDOS, SIEMPRE ──────────────────────────────────────────
//
// Este fichero existe porque el mismo error ha aparecido cuatro veces.
//
// En SQLite, `integer({ mode: "timestamp" })` de Drizzle significa SEGUNDOS.
// No milisegundos. Está escrito así en la librería:
//
//     mapToDriverValue: Math.floor(value.getTime() / 1e3)   // Date → segundos
//     mapFromDriverValue: new Date(value * 1e3)             // segundos → Date
//
// Todo el esquema de CubaGest usa ese modo, y todas las migraciones usan
// `DEFAULT (unixepoch())`, que también da segundos. Esquema y base de datos
// hablan el mismo idioma.
//
// El que no lo hablaba era el SQL escrito a mano: los `INSERT` con
// `DB.prepare().bind(Date.now())` guardaban milisegundos en columnas que
// Drizzle leía como segundos. Cada una de esas filas quedaba mil veces en el
// futuro, y se manifestó de tres maneras distintas:
//
//   - El cierre veía cero ventas, porque el filtro de fechas comparaba
//     milisegundos contra segundos y descartaba todo.
//   - Las fechas del cierre salían fechadas en el año 58709.
//   - La ventana de veinte horas decía que quedaban 496 894 297 horas.
//
// El síntoma se veía en un sitio y la causa estaba en catorce ficheros. Por
// eso las dos funciones de aquí, y sobre todo por eso hay que usarlas en
// CUALQUIER `bind()` que escriba una fecha, sin excepción.

/** Un instante como número de SEGUNDOS, para escribir en la base de datos. */
export function segundos(d: Date | number): number {
  const ms = typeof d === "number" ? d : d.getTime();
  return Math.floor(ms / 1000);
}

/** El instante actual en SEGUNDOS. Para el `DEFAULT (unixepoch())` a mano. */
export function ahoraEnSegundos(): number {
  return Math.floor(Date.now() / 1000);
}
