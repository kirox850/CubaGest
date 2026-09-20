-- Migration 0006 - Panel de plataforma (super-admin)
-- Identidad SEPARADA del login de empresas: el aislamiento multi-tenant del
-- sistema normal no cambia; solo las rutas /platform/* pueden saltarlo.

CREATE TABLE IF NOT EXISTS "platform_admins" (
  "id" TEXT PRIMARY KEY,
  "email" TEXT NOT NULL UNIQUE,
  "name" TEXT NOT NULL DEFAULT 'Admin de Plataforma',
  "password_hash" TEXT NOT NULL,
  "last_login_at" INTEGER,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);

-- Auditoría del panel, separada del audit_logs de empresas (ese exige
-- company_id NOT NULL; las acciones de plataforma son multi-empresa).
CREATE TABLE IF NOT EXISTS "platform_audit_logs" (
  "id" TEXT PRIMARY KEY,
  "admin_id" TEXT REFERENCES "platform_admins"("id") ON DELETE SET NULL,
  "action" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT,
  "detail" TEXT,
  "ip" TEXT,
  "created_at" INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX IF NOT EXISTS "platform_audit_admin_idx" ON "platform_audit_logs"("admin_id");

-- Notas internas por empresa (visibles solo en /panel, nunca para el cliente)
ALTER TABLE "companies" ADD COLUMN "internal_notes" TEXT;
