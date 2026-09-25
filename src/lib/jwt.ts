// JWT con Web Crypto API (compatible con Cloudflare Workers)
// No usar jsonwebtoken — no es compatible con el runtime de Workers
//
// ── PROPÓSITO DEL TOKEN (P0) ────────────────────────────────────────────────
// Antes todos los tokens eran "lo mismo": el payload de un refresh token era
// idéntico al de un access token, así que un refresh robado daba acceso a la
// API completa durante una semana. Ahora CADA token declara para qué es:
//
//   access   → sesión de la app. Única que vale para la API de la empresa.
//   support  → sesión de soporte creada por /panel (impersonación). Vale para
//              la API de la empresa como un admin, pero con vida corta y
//              siempre auditada. Se acepta explícitamente, nunca "por error".
//   refresh  → solo para POST /auth/refresh. NO vale para ninguna API.
//   platform → solo para /panel. NO vale para la API de empresas.
//
// El middleware de empresa acepta access|support; el de plataforma acepta
// platform. Un token con propósito equivocado se rechaza con 401/403.

export type TokenPurpose = "access" | "refresh" | "platform" | "support";

export interface JWTPayload {
  sub: string;
  purpose: TokenPurpose;
  // Claims de sesión de empresa (access|support|refresh)
  userId?: string;
  companyId?: string;
  role?: string;
  // Claims del panel de plataforma (platform)
  adminId?: string;
  email?: string;
  // Claims de impersonación / rotación
  jti?: string;
  type?: string; // legacy: "platform" en tokens del panel emitidos antes de 0007
  exp: number;
  iat: number;
}

function base64UrlEncode(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function base64UrlDecode(str: string): Uint8Array {
  const padding = "=".repeat((4 - (str.length % 4)) % 4);
  const base64 = str.replace(/-/g, "+").replace(/_/g, "/") + padding;
  const binary = atob(base64);
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

function textEncoder(str: string): Uint8Array {
  return new TextEncoder().encode(str);
}

async function importKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    textEncoder(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

// VIDA DE LOS TOKENS (offline-first)
// - access: 9 h. Suficiente para una jornada entera con mala conexión; el
//   cliente lo renueva en silencio (ver POST /auth/refresh).
// - support: 2 h. Sesión de soporte, no de trabajo diario.
// - platform: 12 h (el panel es de escritorio, con buena conexión).
// - refresh: 180 días CORRIENTES. Es la sesión larga que permite al móvil
//   seguir "conectado" hasta que el usuario hace logout explícito. Cada uso
//   la extiende otra vez (sliding) y rota el token.
export const ACCESS_TOKEN_TTL_SECONDS = 9 * 3600;
export const SUPPORT_TOKEN_TTL_SECONDS = 2 * 3600;
export const PLATFORM_TOKEN_TTL_SECONDS = 12 * 3600;
export const REFRESH_TOKEN_TTL_DAYS = 180;

export interface SignOptions {
  purpose: TokenPurpose;
  userId?: string;
  companyId?: string;
  role?: string;
  adminId?: string;
  email?: string;
  jti?: string;
  /** Solo para tokens del panel: se mantiene por compatibilidad. */
  type?: string;
}

export async function signToken(
  opts: SignOptions,
  secret: string,
  expiresInSeconds: number
): Promise<string> {
  const header = { alg: "HS256", typ: "JWT" };
  const now = Math.floor(Date.now() / 1000);
  const fullPayload: JWTPayload = {
    sub: opts.userId || opts.adminId || crypto.randomUUID(),
    purpose: opts.purpose,
    ...(opts.userId ? { userId: opts.userId } : {}),
    ...(opts.companyId ? { companyId: opts.companyId } : {}),
    ...(opts.role ? { role: opts.role } : {}),
    ...(opts.adminId ? { adminId: opts.adminId } : {}),
    ...(opts.email ? { email: opts.email } : {}),
    ...(opts.jti ? { jti: opts.jti } : {}),
    ...(opts.type ? { type: opts.type } : {}),
    iat: now,
    exp: now + expiresInSeconds,
  };

  const headerB64 = base64UrlEncode(textEncoder(JSON.stringify(header)));
  const payloadB64 = base64UrlEncode(textEncoder(JSON.stringify(fullPayload)));
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, textEncoder(signingInput));
  const signatureB64 = base64UrlEncode(signature);

  return `${headerB64}.${payloadB64}.${signatureB64}`;
}

export interface VerifyOptions {
  /** Propósitos que se aceptan para este endpoint. Si se omite, se acepta cualquiera. */
  expect?: TokenPurpose[];
  /**
   * Aceptar tokens emitidos ANTES de la migration 0007 (sin claim "purpose").
   * Solo se usa en /auth/refresh y con la condición extra de que traigan
   * "jti" — antes de 0007 solo los refresh tokens lo tenían, así que un
   * access token viejo nunca se confunde con uno de refresh. Los clientes
   * renovarán su sesión en el próximo refresh; la API de empresa sí exige
   * purpose desde ya.
   */
  allowLegacyUnscoped?: boolean;
}

export async function verifyToken(
  token: string,
  secret: string,
  opts: VerifyOptions = {}
): Promise<JWTPayload> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Token inválido");

  const [headerB64, payloadB64, signatureB64] = parts;
  const signingInput = `${headerB64}.${payloadB64}`;

  const key = await importKey(secret);
  const signature = base64UrlDecode(signatureB64);
  const valid = await crypto.subtle.verify("HMAC", key, signature, textEncoder(signingInput));
  if (!valid) throw new Error("Firma inválida");

  let payload: JWTPayload;
  try {
    const payloadJson = new TextDecoder().decode(base64UrlDecode(payloadB64));
    payload = JSON.parse(payloadJson) as JWTPayload;
  } catch {
    throw new Error("Token malformado");
  }

  // Claims obligatorios: sin exp no hay expiración real, sin sub no hay a qué
  // sesión pertenece el token.
  if (typeof payload.sub !== "string" || !payload.sub) throw new Error("Token sin sujeto");
  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp)) throw new Error("Token sin expiración");
  if (typeof payload.iat !== "number" || !Number.isFinite(payload.iat)) throw new Error("Token sin fecha de emisión");

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp <= now) throw new Error("Token expirado");
  // Token emitido en el futuro (reloj desfasado o manipulado).
  if (payload.iat > now + 60) throw new Error("Token con fecha inválida");

  if (opts.expect && opts.expect.length > 0) {
    // `type: "platform"` es el marcador legacy del panel (0006). Solo se
    // acepta donde además se espera "platform".
    const effective =
      payload.purpose ??
      (payload.type === "platform" && opts.expect.includes("platform") ? "platform" : undefined) ??
      (opts.allowLegacyUnscoped && payload.jti ? "refresh" : undefined);

    if (!effective) throw new Error("Token sin propósito");
    if (!opts.expect.includes(effective)) throw new Error("Tipo de token incorrecto para esta operación");
  }

  return payload;
}

export function generateUUID(): string {
  return crypto.randomUUID();
}
