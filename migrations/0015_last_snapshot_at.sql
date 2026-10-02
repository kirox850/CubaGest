-- Última foto conocida de cada caja (CubaGest_Shift_Chain_Plan, F0).
--
-- El stock dejó de ser un número que se va sumando. Cada lectura y cada cierre
-- registran LA CANTIDAD CONTADA en un instante, y el stock es ese número más lo
-- que ocurra después. Para que eso sea cierto, hace falta saber dónde está la
-- última foto: cualquier venta, movimiento o ajuste cuya hora de negocio sea
-- ANTERIOR a ella ya está dentro del número contado, y aplicarla otra vez sería
-- descontar dos veces lo mismo.
--
-- Sin esta columna no hay forma de distinguir "una venta que llegó tarde" de "una
-- venta de ahora", y el fallo aparece como stock bajo sin explicación.
--
-- NULL = ninguna caja ha sido contada todavía. En ese caso se aplica todo, que es
-- el comportamiento de siempre.

ALTER TABLE inventory_locations ADD COLUMN last_snapshot_at INTEGER;
CREATE INDEX IF NOT EXISTS locations_last_snapshot
  ON inventory_locations(last_snapshot_at);
