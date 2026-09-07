import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { generateUUID } from "./jwt";

// Trazabilidad completa: cualquier acción que cambie datos (crear, editar,
// borrar, aprobar, ajustar stock, etc.) queda registrada acá. Pensado para
// la pestaña de Auditoría (solo admin) — nunca se borra ni se edita.
//
// No usar para lecturas (GET) ni para cosas que ya quedan registradas por sí
// solas con suficiente detalle (ej. una venta ya crea su propia fila en
// `sales`) — logAudit es para el "quién hizo qué y cuándo" que de otra forma
// se pierde, como ediciones de stock, aprobaciones de transferencias, o
// cambios de rol de un usuario.
export async function logAudit(
  env: Env,
  params: {
    companyId: string;
    userId: string | null;
    action: string;    // ej. "product.adjust_stock", "transfer.approve", "user.role_change"
    entity: string;    // ej. "product", "transfer", "user"
    entityId?: string | null;
    detail?: Record<string, unknown> | string | null;
    ip?: string | null;
  }
): Promise<void> {
  try {
    const db = drizzle(env.DB, { schema });
    await db.insert(schema.auditLogs).values({
      id: generateUUID(),
      companyId: params.companyId,
      userId: params.userId,
      action: params.action,
      entity: params.entity,
      entityId: params.entityId ?? null,
      detail: typeof params.detail === "string" ? params.detail : params.detail ? JSON.stringify(params.detail) : null,
      ip: params.ip ?? null,
    });
  } catch (err) {
    // La auditoría nunca debe tumbar la operación principal — si falla el
    // log, solo lo dejamos en consola del Worker.
    console.error("No se pudo registrar en auditoría:", err);
  }
}

// Extrae la IP del request de forma consistente (Cloudflare la manda en este header).
export function getClientIp(c: { req: { header: (name: string) => string | undefined } }): string | null {
  return c.req.header("cf-connecting-ip") || c.req.header("x-real-ip") || null;
}
