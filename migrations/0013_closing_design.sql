-- El diseño de cierres completo: dinero, movimientos, y cierre provisional.
--
-- Hasta aquí el cierre solo reconciliaba INVENTARIO: el dinero se registraba
-- pero nunca se contaba. Y el periodo de cada cierre se guardaba en segundos
-- mientras el código lo leía como milisegundos, así que todo cierre histórico
-- tenía fecha de 1970 y su período era incalculable.

-- ── Arreglar el período de los cierres ya hechos ────────────────────────────
-- Mismo criterio que en 0010 para las ventas: si el valor parece segundos, es
-- que lo está, y se multiplica por 1000 para dejarlo en milisegundos.
UPDATE cash_closings
   SET period_start = period_start * 1000
 WHERE period_start IS NOT NULL AND period_start > 0 AND period_start < 100000000000;

UPDATE cash_closings
   SET period_end = period_end * 1000
 WHERE period_end IS NOT NULL AND period_end > 0 AND period_end < 100000000000;

-- ── Dinero en varias monedas ────────────────────────────────────────────────
-- Cada cantidad se guarda EN SU MONEDA, en un objeto JSON: {"CUP":1200,"USD":20}.
-- Nunca se convierte a una moneda única para guardar: si en la caja hay 100 CUP
-- y 2 USD, eso es lo que hay, y perder la moneda es perder información que el
-- dueño necesita para poder explicarla.

-- El turno sabe con cuánto dinero arrancó la caja (el fondo). Sin esto no hay
-- forma de saber si el faltante es del turno o venía de antes.
ALTER TABLE shifts ADD COLUMN base_cash TEXT NOT NULL DEFAULT '{}';

-- El cierre guarda lo contado, lo esperado y la diferencia, por moneda.
ALTER TABLE cash_closings ADD COLUMN counted_cash TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cash_closings ADD COLUMN expected_cash TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cash_closings ADD COLUMN base_cash TEXT NOT NULL DEFAULT '{}';
ALTER TABLE cash_closings ADD COLUMN cash_diff TEXT NOT NULL DEFAULT '{}';

-- Estado del cierre. "provisional" es un cierre que ya se registró pero tiene
-- un descuadre de dinero esperando explicación; no está resuelto.
ALTER TABLE cash_closings ADD COLUMN status TEXT NOT NULL DEFAULT 'cerrado';

-- La HORA DEL CONTEO, no la de la sincronización. Si el cajero contó a las 8 de
-- la noche pero la caja se subió cuando ya no había internet, la ventana de 20
-- horas corre desde las 8, no desde que volvió la conexión. Si no, un cierre
-- offline podría quedarse abierto días.
ALTER TABLE cash_closings ADD COLUMN counted_at INTEGER;

-- Vence la ventana de provisional. NULL = no aplica.
ALTER TABLE cash_closings ADD COLUMN provisional_until INTEGER;

ALTER TABLE cash_closings ADD COLUMN shift_id TEXT REFERENCES shifts(id);

CREATE INDEX IF NOT EXISTS closings_provisional
  ON cash_closings(status, provisional_until);

-- ── Entradas y salidas de dinero ────────────────────────────────────────────
-- Sin esto, un retiro del dueño es indistinguible de un robo: el cierre lo ve
-- como faltante y avisa de algo que no ocurrió.
CREATE TABLE IF NOT EXISTS cash_movements (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  location_id   TEXT NOT NULL REFERENCES inventory_locations(id) ON DELETE CASCADE,
  -- El turno en el que se registró. NULL si lo hizo un admin sin turno
  -- abierto: un admin puede mover dinero en cualquier momento, un cajero no.
  shift_id      TEXT REFERENCES shifts(id),
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL,             -- entrada | salida
  amount        REAL NOT NULL,
  currency      TEXT NOT NULL DEFAULT 'CUP',
  reason        TEXT,
  status        TEXT NOT NULL DEFAULT 'pendiente',  -- pendiente|aprobada|rechazada
  approved_by_id TEXT REFERENCES users(id),
  approved_at   INTEGER,
  decision_note TEXT,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS cash_movements_pending
  ON cash_movements(company_id, location_id, status);
CREATE INDEX IF NOT EXISTS cash_movements_shift
  ON cash_movements(company_id, shift_id, created_at);

-- ── Explicaciones de un descuadre ───────────────────────────────────────────
-- Cuando el cierre cuadra: se registra y se avisa. Cuando no: queda
-- provisional, y quien cerró el turno dice cuánto y por qué.
CREATE TABLE IF NOT EXISTS closing_explanations (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  closing_id    TEXT NOT NULL REFERENCES cash_closings(id) ON DELETE CASCADE,
  currency      TEXT NOT NULL,
  -- El signo dice en qué sentido se explicaba: negativo = faltante,
  -- positivo = sobrante.
  amount        REAL NOT NULL,
  note          TEXT,
  created_by_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS closing_explanations_by_closing
  ON closing_explanations(closing_id, currency);

-- Un movimiento aprobado no se puede aprobar dos veces: evita que un doble clic
-- o un reintentoOffline lo cuente dos veces en el esperado de la caja.
CREATE UNIQUE INDEX IF NOT EXISTS cash_movements_approved_once
  ON cash_movements(id) WHERE status = 'aprobada';
