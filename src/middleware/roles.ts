import { createMiddleware } from "hono/factory";

const ROLES: Record<string, { label: string; perms: string[] }> = {
  admin:       { label: "Administrador", perms: ["dashboard","inventario","pos","facturacion","contabilidad","cierre","usuarios","config"] },
  cajero:      { label: "Cajero",        perms: ["dashboard","pos","facturacion","cierre"] },
  contador:    { label: "Contador",      perms: ["dashboard","contabilidad","cierre"] },
  almacenista: { label: "Almacenista",   perms: ["dashboard","inventario","cierre"] },
};

export const ROLE_NAMES = Object.keys(ROLES);

export function requireModule(moduleName: string) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const role = c.get("auth")?.role;
    const perms = ROLES[role]?.perms || [];
    if (!perms.includes(moduleName)) {
      return c.json({ ok: false, error: "No tiene permisos para acceder a este módulo" }, 403);
    }
    await next();
  });
}

export function requireRole(...allowedRoles: string[]) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const role = c.get("auth")?.role;
    if (!allowedRoles.includes(role)) {
      return c.json({ ok: false, error: "Acción restringida a: " + allowedRoles.join(", ") }, 403);
    }
    await next();
  });
}

export { ROLES };
