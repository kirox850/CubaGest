-- Comparación entre fotos consecutivas de una caja.
--
-- La cadena de una caja es: apertura → cierre → apertura → cierre. Cada elemento
-- se compara contra su vecina INMEDIATA anterior, no contra la primera. Eso hace
-- que un eslabón que falta solo difiera SU comparación entrante: el resto sigue
-- adelante.
--
-- Deliberadamente NO guarda "el estado del cierre". Esto no decide nada ni
-- reemplaza al provisional de cash_closings: es una capa aparte que compara fotos
-- entre turnos. Un cierre provisional sin descuadre resuelto y una comparación
-- entre turnos son cosas distintas, y confundirlas aquí fue el error que motivó
-- separarlas.
--
-- El estado es una de estas tres:
--   pendiente   — falta la vecina anterior; se reintenta cuando llegue
--   conciliado  — comparado y cuadró
--   diferente   — comparado y hay faltante o sobrante

CREATE TABLE IF NOT EXISTS turn_reconciliations (
  id              TEXT PRIMARY KEY,
  company_id      TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id     TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  -- La foto anterior inmediata y la actual. Snapshot_type: "apertura" | "cierre".
  prev_type       TEXT NOT NULL,
  prev_id         TEXT NOT NULL,
  next_type       TEXT NOT NULL,
  next_id         TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'pendiente',
  -- Diferencias ya restadas de lo esperado. Vacío = cuadró.
  diff_items      TEXT NOT NULL DEFAULT '{}',
  diff_cash       TEXT NOT NULL DEFAULT '{}',
  -- Hora de negocio de cada foto, guardada aquí para no tener que releerlas.
  prev_at         INTEGER NOT NULL,
  next_at         INTEGER NOT NULL,
  reconciled_at   INTEGER,
  created_at      INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS turn_rec_by_location
  ON turn_reconciliations(location_id, next_at);
CREATE INDEX IF NOT EXISTS turn_rec_pending
  ON turn_reconciliations(company_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS turn_rec_unique_pair
  ON turn_reconciliations(location_id, prev_type, prev_id, next_type, next_id);
