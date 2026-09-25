import { createMiddleware } from "hono/factory";

// ── Matriz de roles (FUENTE DE VERDAD = backend) ─────────────────────────────
// El web y el móvil replican esta tabla; el backend es quien la aplica. Si un
// cliente muestra un botón que acá no está, el botón es un bug del cliente.
export const ROLES: Record<string, { label: string; perms: string[] }> = {
  admin: {
    label: "Administrador",
    perms: [
      "dashboard", "inventario", "pos", "facturacion", "contabilidad",
      "cierre", "usuarios", "config", "transferencias", "auditoria",
    ],
  },
  cajero: {
    label: "Cajero",
    perms: ["dashboard", "pos", "facturacion", "cierre", "transferencias"],
  },
  contador: {
    label: "Contador",
    perms: ["dashboard", "contabilidad"],
  },
  almacenista: {
    label: "Almacenista",
    perms: ["dashboard", "inventario", "pos", "cierre", "transferencias"],
  },
};

export const ROLE_NAMES = Object.keys(ROLES);

// Módulos que el backend expone. Sirve para validar de un solo lugar los
// nombres usados en requireModule/requireAnyModule (un nombre mal escrito
// dejaría una ruta sin protección: siempre se compara contra esta lista).
export const MODULES = [
  "dashboard", "inventario", "pos", "facturacion", "contabilidad",
  "cierre", "usuarios", "config", "transferencias", "auditoria",
] as const;
export type ModuleName = (typeof MODULES)[number];

// Lista plana de módulos del rol — se manda al cliente en login/register/me
// para que la UI no tenga que duplicar (ni equivocarse en) esta tabla.
export function modulesForRole(role: string | null | undefined): string[] {
  if (!role) return [];
  return ROLES[role]?.perms ?? [];
}

export function roleHasModule(role: string | null | undefined, moduleName: string): boolean {
  return modulesForRole(role).includes(moduleName);
}

export function requireModule(moduleName: string) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const role = c.get("auth")?.role;
    if (!roleHasModule(role, moduleName)) {
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
    if (!moduleNames.some((m) => roleHasModule(role, m))) {
      return c.json({ ok: false, error: "No tiene permisos para acceder a este módulo" }, 403);
    }
    await next();
  });
}

export function requireRole(...allowedRoles: string[]) {
  return createMiddleware<{ Bindings: Env }>(async (c, next) => {
    const role = c.get("auth")?.role;
    if (!allowedRoles.includes(role || "")) {
      return c.json({ ok: false, error: "Acción restringida a: " + allowedRoles.join(", ") }, 403);
    }
    await next();
  });
}

// ¿Puede este usuario operar sobre una venta concreta? El backend es quien
// decide (no el cliente): admin sobre cualquier venta de su empresa; el resto
// solo sobre ventas que él mismo registró. El rol no compra permiso sobre la
// venta de otro cajero aunque sea de la misma caja/empresa.
export function canMutateSale(
  auth: { userId: string; role: string },
  sale: { userId: string; locationId: string | null }
): { allowed: boolean; reason?: string } {
  if (auth.role === "admin") return { allowed: true };
  if (sale.userId === auth.userId) return { allowed: true };
  return {
    allowed: false,
    reason: "Solo el cajero que hizo la venta (o un administrador) puede modificarla o anularla",
  };
}

export { ROLES as ROLE_MATRIX };
