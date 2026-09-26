-- Arregla la fecha de las ventas que ya estaban guardadas.
--
-- El problema: `sales.created_at` se rellenaba en el SQL crudo con unixepoch(),
-- que da SEGUNDOS, pero Drizzle declara la columna como integer con
-- mode:"timestamp", que espera MILISEGUNDOS. Al leerla, Drizzle hacía
-- new Date(1790454186) → 21 de enero de 1970.
--
-- Qué rompía: el cierre de caja filtra las ventas del período con
-- gte(created_at, fechaDeLaLectura). Con las fechas en 1970 esa comparación
-- NUNCA era cierta, así que ninguna venta entraba jamás a un cierre. El cierre
-- creía que no se había vendido nada y reportaba como faltante todo lo vendido.
--
-- El filtro de abajo solo toca valores que son claramente segundos (menores a
-- 100 000 000 000). Un año en milisegundos son ~3.2e10, y en segundos ~3.2e9,
-- así que el corte está en medio: una fecha ya en ms (o en el futuro) queda
-- intacta. Es idempotente: volver a aplicarla no cambia nada.

UPDATE sales
   SET created_at = created_at * 1000
 WHERE created_at IS NOT NULL
   AND created_at > 0
   AND created_at < 100000000000;

-- Lo mismo para las transferencias: se ordenan por created_at, y con todas en
-- 1970 el listado salía en un orden arbitrario.
UPDATE stock_transfers
   SET created_at = created_at * 1000
 WHERE created_at IS NOT NULL
   AND created_at > 0
   AND created_at < 100000000000;
