-- ── 0009: Avisos del navegador (PWA push) ──────────────────────────────────
-- Tabla 1: a qué navegador se le puede mandar un aviso.
--   El endpoint es la dirección que da el navegador. Es única: si un navegador
--   se suscribe dos veces (recarga, segundo dispositivo), la fila se actualiza
--   en vez de duplicarse.
--
--   `failures` cuenta los fallos de envío. Cuando un navegador deja de existir
--   (se desinstaló la PWA, se borraron los datos) el servicio responde 404/410 y
--   se borra la fila: si no, se acumulan suscripciones muertas para siempre.
--
-- Tabla 2: el aviso guardado en la app.
--   El push es "lo mejor que puede pasar": si el móvil está sin batería o el
--   navegador la cerró a la fuerza, el aviso no llega. Guardarlo aquí significa
--   que la persona lo ve de todos modos al abrir la app. Por eso esta tabla es
--   la fuente de verdad, y el push solo es el empujón.
--
-- Sin esto, un aviso perdido era un aviso perdido para siempre.

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  -- Dirección del navegador. Única en toda la base: un mismo navegador no
  -- puede quedar registrado dos veces ni en dos empresas.
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  last_ok_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS push_company_idx ON push_subscriptions(company_id);
CREATE INDEX IF NOT EXISTS push_user_idx    ON push_subscriptions(user_id);

CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  -- NULL = aviso para toda la empresa (cada usuario lo ve una vez, filtrado por
  -- company_id). Con user_id = aviso personal de esa persona.
  user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  link TEXT,
  data TEXT,
  read_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS notif_company_idx ON notifications(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notif_user_idx    ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notif_unread_idx  ON notifications(company_id, read_at);
