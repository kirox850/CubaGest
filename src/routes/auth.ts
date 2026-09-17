import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { signToken, verifyToken, generateUUID } from "../lib/jwt";
import { hashPassword, comparePassword } from "../lib/hash";
import { authMiddleware } from "../middleware/auth";
import { issuePasswordToken, PENDING_ACTIVATION } from "../lib/passwordTokens";
import { hashToken } from "../lib/tokens";

const auth = new Hono<{ Bindings: Env }>();

// Rate limiting en D1 (no en memoria — Workers son stateless)
// Clave: "ratelimit:{ip}:{ventana_de_15min}"
// Límite: 5 intentos por ventana de 15 minutos por IP
async function checkRateLimit(ip: string, env: Env): Promise<boolean> {
  const windowSecs = 15 * 60;
  const now = Math.floor(Date.now() / 1000);
  const window = Math.floor(now / windowSecs);
  const key = `ratelimit:${ip}:${window}`;

  await env.DB.prepare(
    `INSERT INTO counters (id, value)
     VALUES (?, 1)
     ON CONFLICT(id) DO UPDATE SET value = value + 1`
  ).bind(key).run();

  const row = await env.DB.prepare(
    `SELECT value FROM counters WHERE id = ?`
  ).bind(key).first<{ value: number }>();

  return (row?.value ?? 0) <= 5;
}

function publicUser(
  user: typeof schema.users.$inferSelect,
  company?: typeof schema.companies.$inferSelect
) {
  let effectivePlan = company?.plan || "free";
  if (company?.planExpiry && new Date(company.planExpiry) < new Date()) effectivePlan = "free";
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    role: user.role,
    nit: user.nit,
    company: company
      ? {
          id: company.id,
          name: company.name,
          defaultCurrency: company.defaultCurrency,
          plan: effectivePlan,
          planExpiry: company.planExpiry,
          trialActive:
            company.subscriptionStatus === "trial" &&
            !!company.planExpiry &&
            new Date(company.planExpiry) > new Date(),
        }
      : undefined,
  };
}

// POST /auth/register
auth.post("/register", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{
    companyName: string;
    companyNit?: string;
    name: string;
    email: string;
    password: string;
  }>();
  const { companyName, companyNit, name, email, password } = body;

  if (!companyName || !name || !email || !password) {
    return c.json({ ok: false, error: "Faltan campos requeridos" }, 400);
  }

  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .get();
  if (existing) return c.json({ ok: false, error: "Ya existe un usuario con ese correo" }, 409);

  const planExpiry = new Date();
  planExpiry.setDate(planExpiry.getDate() + 30);

  const companyId = generateUUID();
  await db.insert(schema.companies).values({
    id: companyId,
    name: companyName,
    nit: companyNit || null,
    plan: "empresarial",
    planExpiry,
    subscriptionStatus: "trial",
  });

  const passwordHash = await hashPassword(password);
  const userId = generateUUID();
  const user = await db
    .insert(schema.users)
    .values({ id: userId, companyId, name, email, passwordHash, role: "admin" })
    .returning()
    .get();

  const company = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, companyId))
    .get();

  const token = await signToken(
    { sub: user.id, userId: user.id, companyId, role: user.role },
    c.env.JWT_SECRET,
    8 * 3600
  );

  return c.json({ ok: true, token, user: publicUser(user, company) }, 201);
});

// POST /auth/login
auth.post("/login", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";

  if (!(await checkRateLimit(ip, c.env))) {
    return c.json({ ok: false, error: "Demasiados intentos. Intente de nuevo en 15 minutos." }, 429);
  }

  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ email: string; password: string }>();
  const { email, password } = body;

  if (!email || !password) {
    return c.json({ ok: false, error: "Correo y contraseña requeridos" }, 400);
  }

  const user = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.email, email), eq(schema.users.active, true)))
    .get();
  if (!user) return c.json({ ok: false, error: "Credenciales incorrectas" }, 401);

  if (user.passwordHash === PENDING_ACTIVATION) {
    return c.json({ ok: false, error: "Esta cuenta todavía no tiene contraseña. Revisa el correo con el link para activarla, o pide que te lo reenvíen." }, 401);
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) return c.json({ ok: false, error: "Credenciales incorrectas" }, 401);

  const company = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, user.companyId))
    .get();

  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));

  const accessToken = await signToken(
    { sub: user.id, userId: user.id, companyId: user.companyId, role: user.role },
    c.env.JWT_SECRET,
    3600
  );
  const refreshToken = await signToken(
    { sub: user.id, userId: user.id, companyId: user.companyId, role: user.role, jti: generateUUID() },
    c.env.JWT_SECRET,
    7 * 24 * 3600
  );

  await db.insert(schema.refreshTokens).values({
    id: generateUUID(),
    userId: user.id,
    token: refreshToken,
    expiresAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
  });

  return c.json({ ok: true, accessToken, refreshToken, user: publicUser(user, company) });
});

// POST /auth/refresh
auth.post("/refresh", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ refreshToken: string }>();
  const { refreshToken } = body;
  if (!refreshToken) return c.json({ ok: false, error: "Refresh token requerido" }, 400);

  let payload;
  try {
    payload = await verifyToken(refreshToken, c.env.JWT_SECRET);
  } catch {
    return c.json({ ok: false, error: "Refresh token inválido" }, 401);
  }

  const stored = await db
    .select()
    .from(schema.refreshTokens)
    .where(eq(schema.refreshTokens.token, refreshToken))
    .get();
  if (!stored) return c.json({ ok: false, error: "Refresh token no encontrado" }, 401);

  if (stored.expiresAt && new Date(stored.expiresAt) < new Date()) {
    await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.id, stored.id));
    return c.json({ ok: false, error: "Refresh token expirado" }, 401);
  }

  const newAccessToken = await signToken(
    { sub: payload.sub, userId: payload.userId, companyId: payload.companyId, role: payload.role },
    c.env.JWT_SECRET,
    3600
  );
  return c.json({ ok: true, accessToken: newAccessToken });
});

// POST /auth/logout
auth.post("/logout", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ refreshToken?: string }>();
  if (body.refreshToken) {
    await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.token, body.refreshToken));
  }
  return c.json({ ok: true });
});

// GET /auth/me
auth.get("/me", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const authCtx = c.get("auth");
  const user = await db.select().from(schema.users).where(eq(schema.users.id, authCtx.userId)).get();
  if (!user) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);
  const company = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, user.companyId))
    .get();
  return c.json({ ok: true, user: publicUser(user, company) });
});

// POST /auth/forgot-password
// Siempre responde igual exista o no la cuenta — evita que alguien use esto
// para averiguar qué correos están registrados.
auth.post("/forgot-password", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  if (!(await checkRateLimit(ip, c.env))) {
    return c.json({ ok: false, error: "Demasiados intentos. Intente de nuevo en 15 minutos." }, 429);
  }

  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ email: string }>().catch(() => ({} as { email: string }));
  const genericResponse = { ok: true, message: "Si el correo existe en nuestro sistema, te llegará un link para restablecer tu contraseña." };

  if (!body.email) return c.json(genericResponse);

  const user = await db.select().from(schema.users)
    .where(and(eq(schema.users.email, body.email), eq(schema.users.active, true))).get();
  if (!user) return c.json(genericResponse);

  await issuePasswordToken(c.env, db, user, "forgot_password");
  return c.json(genericResponse);
});

// POST /auth/set-password
// Usa el token de "establecer contraseña" (cuenta nueva) o "olvidé mi
// contraseña" (cuenta existente) — funcionan igual en este endpoint.
auth.post("/set-password", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ token: string; password: string }>();
  const { token, password } = body;

  if (!token || !password) return c.json({ ok: false, error: "Token y contraseña son requeridos" }, 400);
  if (password.length < 8) return c.json({ ok: false, error: "La contraseña debe tener al menos 8 caracteres" }, 400);

  const tokenHash = await hashToken(token);
  const tokenRow = await db.select().from(schema.passwordTokens)
    .where(eq(schema.passwordTokens.tokenHash, tokenHash)).get();

  if (!tokenRow) return c.json({ ok: false, error: "Este link no es válido. Pide que te lo reenvíen." }, 400);
  if (tokenRow.usedAt) return c.json({ ok: false, error: "Este link ya se usó. Pide uno nuevo si necesitas cambiar tu contraseña otra vez." }, 400);
  if (new Date(tokenRow.expiresAt) < new Date()) return c.json({ ok: false, error: "Este link venció. Pide que te lo reenvíen." }, 400);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, tokenRow.userId)).get();
  if (!user) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);

  const passwordHash = await hashPassword(password);
  await db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, user.id));
  await db.update(schema.passwordTokens).set({ usedAt: new Date() }).where(eq(schema.passwordTokens.id, tokenRow.id));

  // Cambiar la contraseña cierra cualquier otra sesión activa — por
  // seguridad, sobre todo si el motivo fue "me hackearon"/"perdí el celular".
  await db.delete(schema.refreshTokens).where(eq(schema.refreshTokens.userId, user.id));

  return c.json({ ok: true, message: "Contraseña establecida correctamente. Ya puedes iniciar sesión." });
});

export default auth;
