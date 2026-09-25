import { drizzle } from "drizzle-orm/d1";
import * as schema from "../db/schema";
import { generateUUID } from "./jwt";
import { generateRawToken, hashToken } from "./tokens";
import { sendEmail, setPasswordEmailHtml } from "./email";

const TOKEN_TTL_HOURS = 48;

// Contraseñas: una sola regla para todos los caminos que las escriben
// (registro, "establecer contraseña" y "olvidé mi contraseña"). Antes cada
// ruta tenía su propio `length < 8` — o ninguno.
export const MIN_PASSWORD_LENGTH = 8;
export const MAX_PASSWORD_LENGTH = 200;

export function validatePassword(password: unknown): { ok: true } | { ok: false; error: string } {
  if (typeof password !== "string" || password.length === 0) {
    return { ok: false, error: "La contraseña es requerida" };
  }
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, error: `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres` };
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return { ok: false, error: `La contraseña no puede superar los ${MAX_PASSWORD_LENGTH} caracteres` };
  }
  if (!password.trim()) {
    return { ok: false, error: "La contraseña no puede ser solo espacios" };
  }
  return { ok: true };
}

// Marcador de "cuenta creada, todavía sin contraseña propia". No es un hash
// pbkdf2 válido, así que comparePassword() nunca lo va a aceptar como
// contraseña real — no hace falta tocar la restricción NOT NULL de la
// columna para lograr el mismo efecto.
export const PENDING_ACTIVATION = "PENDING_ACTIVATION";

// Genera un token de un solo uso, lo guarda (hasheado) y manda el correo con
// el link. Se usa tanto al crear un usuario nuevo (purpose="set_password")
// como en "olvidé mi contraseña" (purpose="forgot_password").
export async function issuePasswordToken(
  env: Env,
  db: ReturnType<typeof drizzle>,
  user: { id: string; name: string; email: string },
  purpose: "set_password" | "forgot_password"
): Promise<{ url: string; emailSent: boolean }> {
  const raw = generateRawToken();
  const tokenHash = await hashToken(raw);
  const expiresAt = new Date(Date.now() + TOKEN_TTL_HOURS * 3600 * 1000);

  await db.insert(schema.passwordTokens).values({
    id: generateUUID(),
    userId: user.id,
    tokenHash,
    purpose,
    expiresAt,
  });

  const frontendUrl = env.APP_URL || "https://cubagest.dpdns.org";
  const url = `${frontendUrl}/?setpw=${raw}`;

  const result = await sendEmail(env, {
    to: user.email,
    subject: purpose === "set_password" ? "Activa tu cuenta de CubaGest" : "Restablece tu contraseña de CubaGest",
    html: setPasswordEmailHtml({ name: user.name, url, isNewAccount: purpose === "set_password" }),
  });

  return { url, emailSent: result.sent };
}
