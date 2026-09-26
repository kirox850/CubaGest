-- Margen de descuadre tolerado en el cierre de caja, POR EMPRESA.
--
-- No es un valor de la plataforma: cada dueño de negocio maneja esto a su
-- manera. Por eso vive en company_settings y no en un ajuste del código.
--
-- Hay dos formas de expresarlo porque un dueño piensa en una cosa y el otro en
-- otra:
--   - 'porcentaje': 1% de lo esperado en dinero. Sirve para negocios grandes,
--     donde 500 CUP de diferencia no es nada pero 50 000 sí.
--   - 'absoluto': una cantidad fija en CUP. Sirve para un kiosco, donde
--     cualquier porcentaje da un número absurdo.
--
-- El default es 0 (no tolera nada) a propósito: si nadie lo configura, el
-- sistema avisa de todo, que es lo prudente. Perdonar descuadres sin que el
-- dueño lo haya pedido sería esconderle dinero.
ALTER TABLE company_settings ADD COLUMN cash_tolerance_mode TEXT NOT NULL DEFAULT 'absoluto';
ALTER TABLE company_settings ADD COLUMN cash_tolerance_value REAL NOT NULL DEFAULT 0;
ALTER TABLE company_settings ADD COLUMN cash_require_approval INTEGER NOT NULL DEFAULT 1;
