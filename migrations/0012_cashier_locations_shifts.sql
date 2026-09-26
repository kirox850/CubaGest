-- Cajas compartidas entre varios cajeros, y turnos.
--
-- El problema que resuelve esto: antes una caja era de UN cajero
-- (inventory_locations.owner_user_id), así que tres cajeros rotando en el
-- mismo mostrador obligaban a tener tres cajas — y tres copias del inventario.
-- La mercancía física es una sola, y se descontaba de tres sitios distintos.
--
-- Ahora la caja es del negocio y se ASIGNA a los cajeros que pueden usarla
-- (muchos a muchos), y el cajero elige con cuál trabaja al abrir su turno.

-- ── Asignación de cajas a cajeros ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS location_assignments (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE UNIQUE INDEX IF NOT EXISTS location_assignments_uniq
  ON location_assignments(company_id, user_id, location_id);
CREATE INDEX IF NOT EXISTS location_assignments_user
  ON location_assignments(company_id, user_id);
CREATE INDEX IF NOT EXISTS location_assignments_location
  ON location_assignments(company_id, location_id);

-- Aquí NO hay trigger que impida asignar la MISMA caja a varios cajeros, y es
-- a propósito: en un mostrador pueden turnar tres personas sobre la misma caja.
-- Lo que impide que eso descuadre el inventario no es la asignación, sino que
-- solo haya un turno abierto por caja (shifts_one_open_per_location, más abajo):
-- mientras la caja está en manos de uno, los demás no pueden abrir turno en ella.
--
-- ── Migrar las cajas que ya existían ────────────────────────────────────────
-- Cada caja con dueño pasa a estar asignada a su dueño, para que ningún
-- negocio que ya vendiera quede con el cajero sin caja. Es idempotente: si
-- la asignación ya existe, no la duplica.
INSERT OR IGNORE INTO location_assignments (id, company_id, user_id, location_id, created_at)
SELECT
  l.owner_user_id || ':' || l.id,
  l.company_id, l.owner_user_id, l.id, l.created_at
FROM inventory_locations l
WHERE l.owner_user_id IS NOT NULL AND l.type = 'caja';

-- ── Turnos ──────────────────────────────────────────────────────────────────
-- Un turno es "esta persona, en esta caja, desde esta hora". El inicio del
-- turno crea la lectura de apertura de esa caja: ese es el punto de partida
-- del conteo, y por eso la caja puede tener varios turnos (varios cajeros o
-- varios días) con su propia lectura cada vez.
CREATE TABLE IF NOT EXISTS shifts (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  started_at    INTEGER NOT NULL DEFAULT (unixepoch()),
  ended_at      INTEGER,
  status        TEXT NOT NULL DEFAULT 'abierto',
  -- La lectura de apertura que creó este turno. El cierre la referencia.
  opening_reading_id TEXT REFERENCES inventory_readings(id),
  notes         TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS shifts_open
  ON shifts(company_id, user_id, status);
CREATE INDEX IF NOT EXISTS shifts_location
  ON shifts(company_id, location_id, started_at);

-- Una caja no puede tener dos turnos abiertos a la vez: es lo que hace
-- confiable la conciliación (un solo turno responde por todo el período).
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_location
  ON shifts(location_id) WHERE status = 'abierto';

-- Un cajero no puede tener dos turnos abiertos a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS shifts_one_open_per_user
  ON shifts(user_id) WHERE status = 'abierto';
