import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import {
  signToken,
  verifyToken,
  generateUUID,
  ACCESS_TOKEN_TTL_SECONDS,
  REFRESH_TOKEN_TTL_DAYS,
} from "../lib/jwt";
import { hashPassword, comparePassword } from "../lib/hash";
import { authMiddleware } from "../middleware/auth";
import { issuePasswordToken, PENDING_ACTIVATION, validatePassword } from "../lib/passwordTokens";
import { hashToken } from "../lib/tokens";
import { modulesForRole } from "../middleware/roles";

const auth = new Hono<{ Bindings: Env }>();

// ── Rate limiting en D1 (no en memoria — Workers son stateless) ──────────────
// DOS contadores por ventana de 15 minutos:
//  - por CUENTA (email): 8 intentos fallidos — protege cada cuenta individual
//  - por IP: 40 intentos fallidos — bloquea abuso distribuido sin castigar a
//    los clientes legítimos que comparten CGNAT de ETECSA (cientos de personas
//    salen por la misma IP pública; el límite viejo de 5 por IP los bloqueaba).
// IMPORTANTE: solo cuentan los intentos FALLIDOS — un login correcto nunca
// consume cupo, así que una tienda con varios cajeros no se auto-bloquea.
const RL_WINDOW_SECS = 15 * 60;
const RL_ACCT_LIMIT = 8;
const RL_IP_LIMIT = 40;

const rlWin = () => Math.floor(Date.now() / 1000 / RL_WINDOW_SECS);
const rlIpKey = (ip: string) => `ratelimit:ip:${ip}:${rlWin()}`;
const rlAcctKey = (email: string) => `ratelimit:acct:${email.toLowerCase().trim()}:${rlWin()}`;

async function rlCount(env: Env, key: string): Promise<number> {
  const row = await env.DB.prepare(`SELECT value FROM counters WHERE id = ?`).bind(key).first<{ value: number }>();
  return row?.value ?? 0;
}

async function rlBump(env: Env, key: string): Promise<void> {
  await env.DB.prepare(
    `INSERT INTO counters (id, value)
     VALUES (?, 1)
     ON CONFLICT(id) DO UPDATE SET value = value + 1`
  ).bind(key).run();
}

// Devuelve null si puede intentarlo, o el mensaje de bloqueo si no.
async function checkRateLimit(env: Env, ip: string, email?: string): Promise<string | null> {
  if ((await rlCount(env, rlIpKey(ip))) > RL_IP_LIMIT) {
    return "Demasiados intentos desde tu conexión. Espera 15 minutos e inténtalo de nuevo.";
  }
  if (email && (await rlCount(env, rlAcctKey(email))) > RL_ACCT_LIMIT) {
    return "Demasiados intentos fallidos para esta cuenta. Espera 15 minutos o restablece tu contraseña.";
  }
  return null;
}

// ── Sesiones ─────────────────────────────────────────────────────────────────
// El refresh token NO se guarda en crudo: en `token_hash` va su SHA-256 (la
// columna `token`, NOT NULL por el esquema, recibe un marcador). Cada refresh
// rota el token; el anterior sigue sirviendo durante la ventana de gracia para
// que un cliente que todavía no guarda el token nuevo no se quede fuera de su
// propia sesión.
const ROTATION_GRACE_DAYS = 30;
const nowSec = () => Math.floor(Date.now() / 1000);

async function createRefreshSession(
  env: Env,
  userId: string,
  companyId: string,
  role: string,
  deviceLabel?: string | null
): Promise<string> {
  const jti = generateUUID();
  const refreshToken = await signToken(
    { purpose: "refresh", userId, companyId, role, jti },
    env.JWT_SECRET,
    REFRESH_TOKEN_TTL_DAYS * 24 * 3600
  );
  const tokenHash = await hashToken(refreshToken);
  const expiresAt = Math.floor((Date.now() + REFRESH_TOKEN_TTL_DAYS * 86400000) / 1000);

  await env.DB.prepare(
    `INSERT INTO refresh_tokens (id, user_id, token, token_hash, expires_at, device_label, created_at)
     VALUES (?, ?, ?, ?, ?, ?, unixepoch())`
  )
    .bind(generateUUID(), userId, `sha256:${tokenHash}`, tokenHash, expiresAt, deviceLabel ?? null)
    .run();

  return refreshToken;
}

interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string | null;
  rotated_at: number | null;
  revoked_at: number | null;
  rotated_to_hash: string | null;
  expires_at: number;
}

/** Busca la sesión por hash del token. `raw` solo para filas legacy (0001-0006). */
async function findSession(env: Env, tokenHash: string, raw: string): Promise<SessionRow | null> {
  return env.DB.prepare(
    `SELECT id, user_id, token_hash, rotated_at, revoked_at, rotated_to_hash, expires_at
       FROM refresh_tokens
      WHERE token_hash = ? OR token = ?
      LIMIT 1`
  ).bind(tokenHash, raw).first<SessionRow>();
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
    // El backend manda los módulos que este rol puede usar. El web y el móvil
    // deben mostrar exactamente estos: la matriz de permisos vive acá.
    modules: modulesForRole(user.role),
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

// ── Alta de empresa (registro) ──────────────────────────────────────────────
// Empresa + configuración + almacén central + admin se crean en UN batch de D1
// (que es una transacción). Antes se insertaba primero la empresa y si fallaba
// el usuario quedaba una empresa huérfana, sin almacén y sin company_settings:
// el producto inicial se perdía en silencio porque products.ts comprobaba
// `if (almacen && stock > 0)`.
auth.post("/register", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{
    companyName: string;
    companyNit?: string;
    name: string;
    email: string;
    password: string;
    referralCode?: string;
  }>().catch(() => ({} as any));

  const companyName = typeof body.companyName === "string" ? body.companyName.trim() : "";
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const email = typeof body.email === "string" ? body.email.trim() : "";

  if (!companyName || !name || !email || !body.password) {
    return c.json({ ok: false, error: "Faltan campos requeridos" }, 400);
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return c.json({ ok: false, error: "El correo no parece válido" }, 400);
  }
  const pw = validatePassword(body.password);
  if (!pw.ok) return c.json({ ok: false, error: pw.error }, 400);

  const existing = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .get();
  if (existing) return c.json({ ok: false, error: "Ya existe un usuario con ese correo" }, 409);

  const planExpiry = new Date();
  planExpiry.setDate(planExpiry.getDate() + 30);

  const companyId = generateUUID();
  const userId = generateUUID();
  // Código de referido propio (único por diseño: prefijo + fragmento de UUID)
  const referralCode = ("CG" + generateUUID().replace(/-/g, "").slice(0, 6)).toUpperCase();
  const passwordHash = await hashPassword(body.password);
  const almacenId = generateUUID();

  // Referido (opcional). La búsqueda va ANTES del batch para poder incluir las
  // sentencias en la misma transacción.
  const refCode = (body.referralCode || "").trim().toUpperCase();
  const referrer = refCode
    ? await db.select().from(schema.companies).where(eq(schema.companies.referralCode, refCode)).get()
    : null;

  const statements: D1PreparedStatement[] = [
    c.env.DB.prepare(
      `INSERT INTO companies (id, name, nit, plan, plan_expiry, subscription_status, referral_code, active, created_at)
       VALUES (?, ?, ?, 'empresarial', ?, 'trial', ?, 1, unixepoch())`
    ).bind(
      companyId, companyName, (body.companyNit || "").trim() || null,
      Math.floor(planExpiry.getTime() / 1000), referralCode
    ),
    c.env.DB.prepare(
      `INSERT INTO company_settings (company_id, currencies, rate_mode, manual_rates, eltoque_rates, updated_at)
       VALUES (?, '["CUP"]', 'manual', '{}', '{}', unixepoch())`
    ).bind(companyId),
    c.env.DB.prepare(
      `INSERT INTO inventory_locations (id, company_id, name, type, owner_user_id, active, created_at)
       VALUES (?, ?, 'Almacén Central', 'almacen', NULL, 1, unixepoch())`
    ).bind(almacenId, companyId),
    c.env.DB.prepare(
      `INSERT INTO users (id, company_id, name, email, password_hash, role, active, created_at)
       VALUES (?, ?, ?, ?, ?, 'admin', 1, unixepoch())`
    ).bind(userId, companyId, name, email, passwordHash),
  ];

  if (referrer && referrer.id !== companyId) {
    statements.push(
      c.env.DB.prepare(`UPDATE companies SET referred_by = ? WHERE id = ?`).bind(referrer.id, companyId),
      c.env.DB.prepare(
        `INSERT INTO referrals (id, referrer_company_id, referred_company_id, status, created_at)
         VALUES (?, ?, ?, 'pendiente', unixepoch())`
      ).bind(generateUUID(), referrer.id, companyId)
    );
  }

  try {
    await c.env.DB.batch(statements);
  } catch (err) {
    // El batch es una transacción: si algo falló, no quedó empresa a medias.
    console.error("register: falló el alta transaccional:", err);
    return c.json(
      { ok: false, error: "No se pudo completar el registro. Inténtalo de nuevo." },
      500
    );
  }

  const user = await db.select().from(schema.users).where(eq(schema.users.id, userId)).get();
  const company = await db.select().from(schema.companies).where(eq(schema.companies.id, companyId)).get();
  if (!user) {
    return c.json({ ok: false, error: "No se pudo completar el registro. Inténtalo de nuevo." }, 500);
  }

  const accessToken = await signToken(
    { purpose: "access", userId: user.id, companyId, role: user.role },
    c.env.JWT_SECRET,
    ACCESS_TOKEN_TTL_SECONDS
  );
  const refreshToken = await createRefreshSession(c.env, user.id, companyId, user.role);

  return c.json(
    {
      ok: true,
      // Contrato de sesión (web y móvil leen los mismos campos):
      //   accessToken  -> Authorization: Bearer, dura expiresIn segundos
      //   refreshToken -> POST /auth/refresh, dura refreshExpiresIn segundos
      //                   (180 días corridos desde el último uso)
      //   token        -> alias legacy de accessToken, para clientes viejos
      // El cliente guarda refreshToken en almacenamiento PERSISTENTE; con eso
      // la sesión sobrevive a cierres de app, reinicios y varios días sin red
      // (el POS registra ventas sin conexión y sincroniza al volver).
      token: accessToken,
      accessToken,
      refreshToken,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      refreshExpiresIn: REFRESH_TOKEN_TTL_DAYS * 24 * 3600,
      user: publicUser(user, company),
    },
    201
  );
});

// POST /auth/login
auth.post("/login", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ email: string; password: string }>().catch(() => ({} as any));
  const email = typeof body.email === "string" ? body.email : "";
  const password = typeof body.password === "string" ? body.password : "";

  if (!email || !password) {
    return c.json({ ok: false, error: "Escribe tu correo y tu contraseña para entrar." }, 400);
  }

  const blocked = await checkRateLimit(c.env, ip, email);
  if (blocked) return c.json({ ok: false, error: blocked }, 429);

  // Revalidación real (punto de control nº1: el login siempre lee la DB).
  const user = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.email, email), eq(schema.users.active, true)))
    .get();
  if (!user) {
    await rlBump(c.env, rlIpKey(ip));
    await rlBump(c.env, rlAcctKey(email));
    return c.json({ ok: false, error: "Correo o contraseña incorrectos. Revisa ambos e inténtalo de nuevo." }, 401);
  }

  if (user.passwordHash === PENDING_ACTIVATION) {
    return c.json({ ok: false, error: "Esta cuenta todavía no tiene contraseña. Revisa el correo con el link para activarla, o pide que te lo reenvíen." }, 401);
  }

  const valid = await comparePassword(password, user.passwordHash);
  if (!valid) {
    await rlBump(c.env, rlIpKey(ip));
    await rlBump(c.env, rlAcctKey(email));
    return c.json({ ok: false, error: "Correo o contraseña incorrectos. Revisa ambos e inténtalo de nuevo." }, 401);
  }

  const company = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, user.companyId))
    .get();

  // Empresa suspendida desde el panel de plataforma → sin login.
  if (company && !company.active) {
    return c.json({ ok: false, error: "Esta empresa está suspendida. Contacta a soporte." }, 403);
  }

  await db.update(schema.users).set({ lastLoginAt: new Date() }).where(eq(schema.users.id, user.id));

  const accessToken = await signToken(
    { purpose: "access", userId: user.id, companyId: user.companyId, role: user.role },
    c.env.JWT_SECRET,
    ACCESS_TOKEN_TTL_SECONDS
  );
  const refreshToken = await createRefreshSession(
    c.env, user.id, user.companyId, user.role, c.req.header("X-Device-Label")
  );

  return c.json({
    ok: true,
    // Mismo contrato que /register: `token` es alias de `accessToken`.
    token: accessToken,
    accessToken,
    refreshToken,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_TTL_DAYS * 24 * 3600,
    user: publicUser(user, company),
  });
});

// POST /auth/refresh
// Punto de control nº2: aquí SÍ se releen usuario y empresa. Es el momento en
// que una baja, un cambio de rol o una suspensión surten efecto, sin tener que
// meter una lectura a la base en cada request normal.
//
// La sesión es LARGA (180 días) y CORRIENTE: cada refresh la extiende y rota el
// token, de modo que la app móvil se mantiene "conectada" hasta que el usuario
// hace logout explícito (que sí revoca en el servidor).
auth.post("/refresh", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ refreshToken: string }>().catch(() => ({} as any));
  const refreshToken = body.refreshToken;
  if (typeof refreshToken !== "string" || !refreshToken) {
    return c.json({ ok: false, error: "Refresh token requerido" }, 400);
  }

  try {
    // Solo vale un token de propósito "refresh": un access token usado aquí
    // se rechaza (y un token del panel, también).
    await verifyToken(refreshToken, c.env.JWT_SECRET, {
      expect: ["refresh"],
      allowLegacyUnscoped: true,
    });
  } catch {
    return c.json({ ok: false, error: "Refresh token inválido", code: "REFRESH_INVALID" }, 401);
  }

  const tokenHash = await hashToken(refreshToken);
  const stored = await findSession(c.env, tokenHash, refreshToken);
  if (!stored) {
    // La sesión no existe en la base: se cerró con logout, se borró al cambiar
    // la contraseña, o el token nunca fue emitido por este servidor.
    return c.json({ ok: false, error: "Sesión cerrada. Inicia sesión de nuevo.", code: "SESSION_REVOKED" }, 401);
  }

  const now = nowSec();
  if (stored.rotated_at && stored.rotated_to_hash) {
    // Token ya sustituido. Solo sigue sirviendo si la sesión SUSTITUTA sigue
    // viva: si el usuario hizo logout (que borra la sesión nueva) o esta pasó
    // su expiración, el token viejo tampoco puede resucitar la sesión.
    const successor = await c.env.DB.prepare(
      `SELECT id, expires_at FROM refresh_tokens WHERE token_hash = ? LIMIT 1`
    ).bind(stored.rotated_to_hash).first<{ id: string; expires_at: number }>();
    if (!successor || (successor.expires_at && successor.expires_at <= now)) {
      await c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE id = ?`).bind(stored.id).run();
      return c.json({ ok: false, error: "Sesión cerrada. Inicia sesión de nuevo.", code: "SESSION_REVOKED" }, 401);
    }
    if (!stored.revoked_at || stored.revoked_at <= now) {
      // Fuera de la ventana de gracia: el token viejo ya no vale.
      await c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE id = ?`).bind(stored.id).run();
      return c.json({ ok: false, error: "Refresh token expirado", code: "REFRESH_EXPIRED" }, 401);
    }
  } else if (stored.revoked_at) {
    return c.json({ ok: false, error: "Sesión cerrada. Inicia sesión de nuevo.", code: "SESSION_REVOKED" }, 401);
  }

  if (stored.expires_at && stored.expires_at <= now) {
    await c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE id = ?`).bind(stored.id).run();
    return c.json({ ok: false, error: "Refresh token expirado", code: "REFRESH_EXPIRED" }, 401);
  }

  // Revalidación completa del estado actual del usuario y de la empresa.
  const user = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.id, stored.user_id), eq(schema.users.active, true)))
    .get();
  if (!user) {
    await c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE id = ?`).bind(stored.id).run();
    return c.json({ ok: false, error: "Tu cuenta ya no está activa. Contacta al administrador.", code: "USER_INACTIVE" }, 401);
  }

  const companyRow = await db
    .select({ active: schema.companies.active, id: schema.companies.id })
    .from(schema.companies)
    .where(eq(schema.companies.id, user.companyId))
    .get();
  if (companyRow && !companyRow.active) {
    return c.json({ ok: false, error: "Empresa suspendida", code: "COMPANY_SUSPENDED" }, 403);
  }

  const newAccessToken = await signToken(
    { purpose: "access", userId: user.id, companyId: user.companyId, role: user.role },
    c.env.JWT_SECRET,
    ACCESS_TOKEN_TTL_SECONDS
  );

  // El cliente sigue con un token que YA fue sustituido (viene con el token
  // viejo) y está dentro de la ventana de gracia: no se rota otra vez (se
  // generaría una cadena infinita) y no se devuelve refreshToken, porque la
  // fila sucesora solo guarda su hash y no se puede reemitir en crudo. En su
  // lugar se CORRE la ventana: cada refresh válido la empuja 30 días hacia
  // adelante mientras la sesión sucesora siga viva. Así, un cliente antiguo
  // que nunca guarda el token nuevo tampoco se queda fuera tras estar semanas
  // sin conexión.
  if (stored.rotated_at && stored.rotated_to_hash) {
    await c.env.DB.prepare(
      `UPDATE refresh_tokens SET last_used_at = ?, revoked_at = ?, expires_at = ? WHERE id = ?`
    ).bind(now, now + ROTATION_GRACE_DAYS * 86400, now + ROTATION_GRACE_DAYS * 86400, stored.id).run();
    return c.json({
      ok: true,
      accessToken: newAccessToken,
      refreshToken: null, // "conserva el que ya tienes"
      rotated: false,
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    });
  }

  // Rotación: el nuevo token vive 180 días más a partir de ahora.
  const newRefreshToken = await signToken(
    { purpose: "refresh", userId: user.id, companyId: user.companyId, role: user.role, jti: generateUUID() },
    c.env.JWT_SECRET,
    REFRESH_TOKEN_TTL_DAYS * 24 * 3600
  );
  const newHash = await hashToken(newRefreshToken);
  const graceUntil = now + ROTATION_GRACE_DAYS * 86400;
  const newExpiresAt = now + REFRESH_TOKEN_TTL_DAYS * 86400;

  try {
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO refresh_tokens (id, user_id, token, token_hash, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, unixepoch())`
      ).bind(generateUUID(), user.id, `sha256:${newHash}`, newHash, newExpiresAt),
      c.env.DB.prepare(
        `UPDATE refresh_tokens
            SET rotated_at = ?, revoked_at = ?, rotated_to_hash = ?, last_used_at = ?, expires_at = ?
          WHERE id = ?`
      ).bind(now, graceUntil, newHash, now, graceUntil, stored.id),
    ]);
  } catch (err) {
    console.error("refresh: no se pudo rotar la sesión:", err);
    return c.json({ ok: false, error: "No se pudo renovar la sesión. Inténtalo de nuevo.", code: "REFRESH_ROTATE_FAILED" }, 503);
  }

  return c.json({
    ok: true,
    accessToken: newAccessToken,
    refreshToken: newRefreshToken,
    rotated: true,
    expiresIn: ACCESS_TOKEN_TTL_SECONDS,
    refreshExpiresIn: REFRESH_TOKEN_TTL_DAYS * 24 * 3600,
  });
});

// POST /auth/logout
// Revoca la sesión en el servidor (y solo la sesión de este dispositivo). NO
// le dice al cliente que borre su catálogo ni su cola offline: eso es decisión
// del cliente, y en un dispositivo personal la app conserva sus datos locales.
auth.post("/logout", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const authCtx = c.get("auth");
  const body = await c.req.json<{ refreshToken?: string; allDevices?: boolean }>()
    .catch(() => ({} as { refreshToken?: string; allDevices?: boolean }));

  if (body.refreshToken) {
    const tokenHash = await hashToken(body.refreshToken);
    await db.delete(schema.refreshTokens)
      .where(eq(schema.refreshTokens.token, body.refreshToken))
      .run();
    await c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE token_hash = ?`).bind(tokenHash).run();
  } else if (body.allDevices) {
    await db.delete(schema.refreshTokens)
      .where(eq(schema.refreshTokens.userId, authCtx.userId))
      .run();
  }

  return c.json({ ok: true });
});

// GET /auth/me
// Punto de control nº3 (arranque de la app, vuelta al primer plano, pantalla
// de sesión). Aquí sí se relee el estado real: usuario activo, empresa activa y
// rol vigente. El cliente guarda esta respuesta y la usa sin conexión; cuando
// vuelve a estar online la refresca.
auth.get("/me", authMiddleware, async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const authCtx = c.get("auth");
  const user = await db.select().from(schema.users).where(eq(schema.users.id, authCtx.userId)).get();
  if (!user || !user.active) {
    return c.json({ ok: false, error: "Tu cuenta ya no está activa", code: "USER_INACTIVE" }, 401);
  }
  // El companyId del token es una "copia" que puede quedar vieja (cambios de
  // rol, suspensiones). El que manda es el de la fila del usuario.
  if (user.companyId !== authCtx.companyId) {
    return c.json({ ok: false, error: "Sesión desactualizada. Inicia sesión de nuevo.", code: "SESSION_STALE" }, 401);
  }
  const company = await db
    .select()
    .from(schema.companies)
    .where(eq(schema.companies.id, user.companyId))
    .get();
  if (company && !company.active) {
    return c.json({ ok: false, error: "Esta empresa está suspendida. Contacta a soporte.", code: "COMPANY_SUSPENDED" }, 403);
  }
  return c.json({
    ok: true,
    user: publicUser(user, company),
    serverTime: new Date().toISOString(),
  });
});

// POST /auth/forgot-password
// Siempre responde igual exista o no la cuenta — evita que alguien use esto
// para averiguar qué correos están registrados.
auth.post("/forgot-password", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") || "unknown";
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ email: string }>().catch(() => ({} as { email: string }));
  const genericResponse = { ok: true, message: "Si el correo existe en nuestro sistema, te llegará un link para restablecer tu contraseña." };

  const blocked = await checkRateLimit(c.env, ip, body.email);
  if (blocked) return c.json({ ok: false, error: blocked }, 429);

  if (!body.email) return c.json(genericResponse);

  // Cada solicitud consume cupo (no hay "intento fallido" que verificar aquí)
  await rlBump(c.env, rlIpKey(ip));
  await rlBump(c.env, rlAcctKey(body.email));

  const user = await db.select().from(schema.users)
    .where(and(eq(schema.users.email, body.email), eq(schema.users.active, true))).get();
  if (!user) return c.json(genericResponse);

  await issuePasswordToken(c.env, db, user, "forgot_password");
  return c.json(genericResponse);
});

// POST /auth/set-password
// Usa el token de "establecer contraseña" (cuenta nueva) o "olvidé mi
// contraseña" (cuenta existente) — funcionan igual en este endpoint.
//
// El consumo del token es ATÓMICO: reclamar → cambiar contraseña → cerrar otras
// sesiones van en un solo batch (transacción). Antes era leer "¿ya se usó?" y
// luego marcarlo, de modo que dos peticiones simultáneas con el mismo link
// cambiaban la contraseña dos veces.
auth.post("/set-password", async (c) => {
  const db = drizzle(c.env.DB, { schema });
  const body = await c.req.json<{ token: string; password: string }>().catch(() => ({} as any));
  const { token } = body;
  const { password } = body;

  if (!token || !password) return c.json({ ok: false, error: "Token y contraseña son requeridos" }, 400);
  const pw = validatePassword(password);
  if (!pw.ok) return c.json({ ok: false, error: pw.error }, 400);

  const tokenHash = await hashToken(token);
  const tokenRow = await db.select().from(schema.passwordTokens)
    .where(eq(schema.passwordTokens.tokenHash, tokenHash)).get();

  if (!tokenRow) return c.json({ ok: false, error: "Este link no es válido. Pide que te lo reenvíen." }, 400);
  if (tokenRow.usedAt) return c.json({ ok: false, error: "Este link ya se usó. Pide uno nuevo si necesitas cambiar tu contraseña otra vez." }, 400);
  if (new Date(tokenRow.expiresAt) < new Date()) return c.json({ ok: false, error: "Este link venció. Pide que te lo reenvíen." }, 400);

  const user = await db.select().from(schema.users).where(eq(schema.users.id, tokenRow.userId)).get();
  if (!user) return c.json({ ok: false, error: "Usuario no encontrado" }, 404);

  const passwordHash = await hashPassword(password);

  try {
    const changes = await c.env.DB.batch([
      // Reclamo condicional: si otro proceso lo reclamó antes, cambia 0 filas
      // y el batch entero falla.
      c.env.DB.prepare(
        `UPDATE password_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?`
      ).bind(nowSec(), tokenRow.id, nowSec()),
      c.env.DB.prepare(`UPDATE users SET password_hash = ? WHERE id = ?`).bind(passwordHash, user.id),
      // Cambiar la contraseña cierra cualquier otra sesión activa — por
      // seguridad, sobre todo si el motivo fue "me hackearon"/"perdí el celular".
      c.env.DB.prepare(`DELETE FROM refresh_tokens WHERE user_id = ?`).bind(user.id),
    ]);
    if ((changes[0]?.meta?.changes ?? 0) === 0) {
      return c.json({ ok: false, error: "Este link ya se usó. Pide uno nuevo si necesitas cambiar tu contraseña otra vez." }, 400);
    }
  } catch (err) {
    console.error("set-password: fallo el consumo del token:", err);
    return c.json({ ok: false, error: "No se pudo establecer la contraseña. Pide un link nuevo." }, 409);
  }

  return c.json({ ok: true, message: "Contraseña establecida correctamente. Ya puedes iniciar sesión." });
});

export default auth;
