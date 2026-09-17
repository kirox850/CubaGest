import { createMiddleware } from "hono/factory";

const ROLES: Record<string, { label: string; perms: string[] }> = {
  admin:       { label: "Administrador", perms: ["dashboard","inventario","facturacion","contabilidad","cierre","usuarios","config","auditoria"] },
  cajero:      { label: "Cajero",        perms: ["dashboard","pos","facturacion","cierre","auditoria"] },
  contador:    { label: "Contador",      perms: ["dashboard","contabilidad","cierre","auditoria"] },
  almacenista: { label: "Almacenista",   perms: ["dashboard","inventario","pos","cierre","auditoria"] },
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

// Como requireModule, pero pasa si el rol tiene AL MENOS UNO de los módulos
// dados. Útil para endpoints de solo-lectura que varios módulos necesitan
// (ej. leer el catálogo de productos lo necesitan tanto "inventario" como
// "pos" y "facturacion", aunque solo "inventario" pueda editarlo).
export function requireAnyModule(...moduleNames: string[]) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const role = c.get("auth")?.role;
    const perms = ROLES[role]?.perms || [];
    if (!moduleNames.some(m => perms.includes(m))) {
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
