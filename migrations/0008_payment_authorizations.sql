-- Migration 0008 — Autorizaciones de pago de un solo uso (QvaPay)
--
-- PROBLEMA QUE ARREGLA
-- El callback de QvaPay llegaba con `remote_id = "<companyId>:<plan>"` en la
-- URL, y el backend leía empresa y plan directamente de ahí. Con solo abrir
--   GET /api/subscription/qvapay-callback?remote_id=<empresa>:empresarial&data=<...>
-- se podía marcar esa empresa como autorizada, asignarle un user_uuid
-- arbitrario (que es a quién se le cobra la renovación) y darle 30 días de
-- plan. La firma que manda QvaPay se calculaba pero NO se comprobaba, y el
-- bloque que la calculaba ni siquiera se ejecutaba si no venía `token`.
--
-- SOLUCIÓN
-- El remote_id que le mandamos a QvaPay deja de ser un identificador adivinable
-- y pasa a ser un `state` aleatorio de 256 bits, con una fila en esta tabla
-- que dice a qué empresa y a qué plan corresponde. El callback resuelve
-- empresa y plan desde AQUÍ, no desde la URL. Además es de un solo uso y
-- caduca a los 10 minutos, así que refrescar la página de QvaPay no vuelve a
-- cobrar.
--
-- Es 100% aditiva: no toca ninguna tabla existente ni ninguna fila.

CREATE TABLE IF NOT EXISTS "payment_authorizations" (
  "state" TEXT PRIMARY KEY,
  "company_id" TEXT NOT NULL REFERENCES "companies"("id") ON DELETE CASCADE,
  "plan" TEXT NOT NULL,
  "user_id" TEXT,
  "qvapay_user_uuid" TEXT,
  -- pending: autorizado por el admin, esperando el callback.
  -- charging: ya se intentó el cobro (QvaPay pudo haberlo aplicado).
  -- charged:  cobrado y suscripción activa.
  -- failed:   QvaPay respondió que el cobro no era posible. NADA se escribió
  --           en companies: la empresa no queda autorizada a medias.
  "status" TEXT NOT NULL DEFAULT 'pending',
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch()),
  "expires_at" INTEGER NOT NULL,
  "completed_at" INTEGER,
  "error" TEXT
);

-- La app revisa "lo que me falta por caducar" (limpieza y reconciliación).
CREATE INDEX IF NOT EXISTS "pa_status_idx" ON "payment_authorizations" ("status");
-- La app revisa "las autorizaciones de esta empresa" (panel, soporte).
CREATE INDEX IF NOT EXISTS "pa_company_idx" ON "payment_authorizations" ("company_id");
-- Barrido de las viejas (cron diario).
CREATE INDEX IF NOT EXISTS "pa_created_idx" ON "payment_authorizations" ("created_at");
