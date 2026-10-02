-- De dónde salió el número de cada foto, y si el negocio quiere contar al abrir.
--
-- `origen` responde a una pregunta que sin él no tiene respuesta: si hubo un
-- descuadre, ¿nació en un turno donde alguien contó o en uno donde se heredó el
-- número de antes? El cajero puede tener razón ("me dejaron 89") y el sistema no
-- tener forma de comprobarlo.
--
--   contado  → alguien contó físicamente
--   heredado → se copió de la foto anterior de la caja
--
-- `opening_inherits_previous` es el ajuste 2 del plan. Por defecto 0, es decir,
-- DESACTIVADO: la apertura se cuenta. Ponerlo en 1 hace que la apertura copie la
-- foto anterior, que ahorra el conteo pero deja la caja sin verificar en el
-- cambio de turno.

ALTER TABLE inventory_readings ADD COLUMN origen TEXT NOT NULL DEFAULT 'contado';
ALTER TABLE inventory_readings ADD COLUMN is_opening INTEGER NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS readings_by_location
  ON inventory_readings(location_id, created_at);

ALTER TABLE company_settings ADD COLUMN opening_inherits_previous
  INTEGER NOT NULL DEFAULT 0;

-- Hora de negocio de un movimiento de dinero. `created_at` es CUÁNDO LLEGÓ al
-- servidor; un retiro de la caja fuerte registrado cuando volvió la conexión
-- tiene que contar desde el día en que SAHIO el dinero, o la conciliación de la
-- apertura siguiente lo cuenta en el periodo equivocado.
--
-- NULL = usar created_at. Así una base ya existente no necesita reescribirse.
ALTER TABLE cash_movements ADD COLUMN business_at INTEGER;
