-- Un cierre pertenece a un turno, y el turno no se da por cerrado hasta que el
-- cierre se envía.
--
-- Antes el cierre tomaba "la última lectura sin usar" y rechazaba con 409 si ya
-- se había confirmado. Eso obligaba a que hubiera una lectura por cierre y hacía
-- fácil asociar el cierre con el turno equivocado. Ahora cada turno tiene SU
-- lectura de apertura, y el cierre se hace contra esa.
--
-- ended_at se rellena cuando el cierre llega al servidor, no cuando el cajero
-- pulsa "terminar turno": si el cierre se queda en la cola sin conexión, el turno
-- sigue abierto a propósito.

-- ended_at YA existe desde antes: el inicio del turno ya se guardaba. Aquí solo
-- se añade el enlace al cierre.
ALTER TABLE shifts ADD COLUMN closing_id TEXT REFERENCES cash_closings(id);
CREATE INDEX IF NOT EXISTS shifts_by_closing ON shifts(closing_id);
