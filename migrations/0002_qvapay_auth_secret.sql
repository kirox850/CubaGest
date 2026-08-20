-- Agrega la columna para guardar el token de autorización de QvaPay
-- (auth_secret) que hay que reenviar en cada /v2/charge. Antes solo se
-- guardaba qvapay_user_uuid, que no es suficiente para cobrar según el
-- SDK oficial de QvaPay (charge_user espera un "token", no solo el uuid).
ALTER TABLE "companies" ADD COLUMN "qvapay_auth_secret" TEXT;
