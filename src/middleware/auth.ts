import { createMiddleware } from "hono/factory";
import { verifyToken } from "../lib/jwt";

export interface AuthContext {
  userId: string;
  companyId: string;
  role: string;
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export const authMiddleware = createMiddleware<{ Bindings: Env }>(async (c, next) => {
  const header = c.req.header("Authorization") || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return c.json({ ok: false, error: "Token no proporcionado" }, 401);
  }

  try {
    const payload = await verifyToken(token, c.env.JWT_SECRET);
    c.set("auth", {
      userId: payload.userId,
      companyId: payload.companyId,
      role: payload.role,
    });
    await next();
  } catch {
    return c.json({ ok: false, error: "Token inválido o expirado" }, 401);
  }
});
