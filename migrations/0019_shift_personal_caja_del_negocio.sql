-- EL TURNO ES DE LA PERSONA; LA CAJA ES DEL NEGOCIO.
--
-- Este índice era lo que realmente impedía dos turnos en la misma caja, más que
-- el 409 del endpoint. Quitar solo el check de la ruta no habría hecho nada: la
-- base habría rechazado el segundo turno con una violación de índice único, y el
-- cajero se habría encontrado un error de servidor en vez de un mensaje claro.
--
-- Por qué se quita: si un cierre se queda en la cola sin conexión, el turno sigue
-- abierto a propósito. Con este índice, el negocio quedaba parado hasta que
-- volviera la red. Ahora dos personas pueden tener turno abierto en la MISMA caja;
-- cada turno lleva su propia lectura de apertura y su propio cierre, y la cadena
-- de turnos (0015) evita que los dos contees se ajusten dos veces.
--
-- Lo que NO se toca es `shifts_one_open_per_user`: una persona con dos turnos
-- abiertos a la vez sigue siendo un error real, y ese índice lo sigue impidiendo
-- a nivel de base, que es donde tiene que estar.

DROP INDEX IF EXISTS shifts_one_open_per_location;

CREATE INDEX IF NOT EXISTS shifts_open_by_location
  ON shifts(location_id) WHERE status = 'abierto';
