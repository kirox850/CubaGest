-- Notas sobre faltantes de mercadería.
--
-- Deliberadamente separadas de closing_explanations. Allí vive lo que RESUELVE
-- un descuadre de dinero; aquí vive lo que solo se escribe para que quede
-- dicho por qué faltó o sobró mercancía. Una nota no cambia el estado del
-- cierre ni lo resuelve: el cierre se resuelve cuando todas las líneas
-- cuadran, y una nota no cuadra ninguna línea por sí sola.
--
-- Estar en la misma tabla habría sido más corto y mucho peor: una nota
-- guardada como explicación habría cerrado un descuadre que nadie explicó.

CREATE TABLE IF NOT EXISTS closing_notes (
  id            TEXT PRIMARY KEY,
  company_id    TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  closing_id    TEXT NOT NULL REFERENCES cash_closings(id) ON DELETE CASCADE,
  product_id    TEXT,
  product_name  TEXT,
  -- Positivo = faltante, negativo = sobrante. Guardado el signo para poder
  -- mostrar "sobran 2" sin tener que recalcularlo leyendo el conteo.
  qty           REAL NOT NULL DEFAULT 0,
  note          TEXT NOT NULL,
  created_by_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at    INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS closing_notes_by_closing
  ON closing_notes(closing_id);
