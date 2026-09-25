import { createMiddleware } from "hono/factory";
import { verifyToken } from "../lib/jwt";

export interface AuthContext {
  userId: string;
  companyId: string;
  role: string;
  /** "support" = sesión creada por el panel de plataforma (impersonación). */
  tokenPurpose: "access" | "support";
  /** claims originales (útil para auditoría/depuración puntual). */
  issuedAt: number;
  expiresAt: number;
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

// ── Requests API ordinarios: SIN lectura a la base de datos ──────────────────
// Decisión deliberada (Cuba, conectividad intermitente): el middleware se
// limita a VERIFICAR LA FIRMA del token. Meter un SELECT de users/companies en
// cada petición significaría que, sin datos, el negocio entero se cae.
//
// El estado real (usuario activo, empresa no suspendida, rol vigente) se
// revalida en los únicos puntos donde el cliente ya hace una ida al servidor y
// ya está pagando la latencia:
//   - POST /auth/register  - POST /auth/login  - POST /auth/refresh
//   - GET  /auth/me  (arranque de la app, vuelta al primer plano, sesión revalidada)
//
// La ventana de seguridad entre refresh y refresh es aceptada a cambio de que
// una venta no se caiga por una petición de red perdida. Una baja de usuario o
// una suspensión de empresa surte efecto en el siguiente refresh o /auth/me, y
// el logout siempre revoca en el servidor.
export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return c.json({ ok: false, error: "Token no proporcionado" }, 401);
  }

  try {
    // Separación de carriles: aquí SOLO valen access y support. Un refresh o
    // un token del panel de plataforma se rechazan aunque la firma sea buena.
    const payload = await verifyToken(token, c.env.JWT_SECRET, { expect: ["access", "support"] });
    if (!payload.userId || !payload.companyId || !payload.role) {
      return c.json({ ok: false, error: "Token incompleto" }, 401);
    }
    c.set("auth", {
      userId: payload.userId,
      companyId: payload.companyId,
      role: payload.role,
      // verifyToken ya menjamin que el propósito es access o support; el ternario
      // solo le hace el tipo al compilador.
      tokenPurpose: payload.purpose === "support" ? "support" : "access",
      issuedAt: payload.iat,
      expiresAt: payload.exp,
    });
    await next();
  } catch {
    return c.json(
      { ok: false, error: "Token inválido o expirado", code: "TOKEN_INVALID" },
      401
    );
  }
});
