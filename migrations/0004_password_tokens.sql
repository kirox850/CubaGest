-- Tokens de un solo uso para "establecer contraseña" / "olvidé mi
-- contraseña". No se toca la tabla users -- se usa un valor centinela en
-- password_hash ("PENDING_ACTIVATION") para cuentas sin contraseña propia
-- todavía, evitando tener que recrear esa tabla (SQLite no permite relajar
-- un NOT NULL con ALTER TABLE sin recrear la tabla entera).

CREATE TABLE IF NOT EXISTS "password_tokens" (
  "id" TEXT PRIMARY KEY,
  "user_id" TEXT NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "token_hash" TEXT NOT NULL,
  "purpose" TEXT NOT NULL,
  "expires_at" INTEGER NOT NULL,
  "used_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS "password_tokens_user_idx" ON "password_tokens"("user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "password_tokens_hash_idx" ON "password_tokens"("token_hash");
