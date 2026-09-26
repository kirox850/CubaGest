// Cliente mínimo para la API de QvaPay (cobros recurrentes / autorizados)
// Documentación oficial: https://www.qvapay.com/docs
//
// Todos los endpoints de "merchant" usan credenciales de App (app-id + app-secret)
// enviadas como headers, contra la base https://api.qvapay.com

const QVAPAY_API_BASE = "https://api.qvapay.com";

class QvaPayError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function qvapayRequest(env: Env, path: string, body: Record<string, unknown>) {
  if (!env.QVAPAY_APP_ID || !env.QVAPAY_APP_SECRET) {
    throw new QvaPayError("QvaPay no está configurado (faltan QVAPAY_APP_ID / QVAPAY_APP_SECRET)", 500);
  }
  const res = await fetch(`${QVAPAY_API_BASE}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "app-id": env.QVAPAY_APP_ID,
      "app-secret": env.QVAPAY_APP_SECRET,
    },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new QvaPayError((data as any)?.error || `Error QvaPay (${res.status})`, res.status);
  }
  return data as any;
}

// POST /v2/authorize_payments
// Genera una URL a la que hay que redirigir al usuario para que autorice
// cobros recurrentes directos desde nuestra app. Requiere que la app tenga
// el permiso "allowed_payment_auth" habilitado por soporte de QvaPay.
export async function qvapayAuthorizePayments(env: Env, remoteId: string, callbackUrl: string) {
  return qvapayRequest(env, "/v2/authorize_payments", {
    remote_id: remoteId,
    callback: callbackUrl,
  }) as Promise<{ message: string; url: string }>;
}

// POST /v2/charge
// Cobra directamente el balance de un usuario que ya autorizó pagos a la app.
//
// Confirmado con la documentación oficial (qvapay.com/docs/merchants/charge):
// el request solo lleva amount, user_uuid, description y remote_id. NO hay
// campo "token" — la suposición anterior de mandar el auth_secret como
// "token" venía de un SDK no oficial y no coincide con la doc real.
export async function qvapayCharge(
  env: Env,
  params: { amount: number; userUuid: string; description: string; remoteId: string }
) {
  return qvapayRequest(env, "/v2/charge", {
    amount: params.amount,
    user_uuid: params.userUuid,
    description: params.description,
    remote_id: params.remoteId,
  }) as Promise<{
    success: boolean;
    message: string;
    transaction: { uuid: string; amount: number; description: string; remote_id: string; status: string };
  }>;
}

// Verifica (sin bloquear) que el callback de authorize_payments venga
// firmado como esperamos.
//
// HECHOS (logs reales de producción, 2026-09-26): el token que llega SÍ es
// HMAC-SHA256(app_secret, data) — "hash calculado coincide con token
// recibido: true" en un callback auténtico, y el data resultante es un JSON
// Base64 con {remote_id, user_uuid, user_email, user_name, verified,
// auth_secret}. O sea que nuestra suposición era correcta.
//
// Aun así NO se usa para rechazar: la doc oficial de QvaPay sigue sin
// documentar el formato del callback ni el algoritmo, así que si QvaPay lo
// cambiara alguna vez, un rechazo bloquearía TODAS las suscripciones nuevas.
// La garantía real de que un callback es legítimo no es esta firma, sino la
// tabla payment_authorizations (0008): el remote_id del callback tiene que
// coincidir con un state de un solo uso que el propio admin generó hace unos
// minutos desde la app. La firma queda como alerta.
export async function qvapayComputeHmac(appSecret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const signatureBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(signatureBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// ── Clasificación de un fallo de cobro ──────────────────────────────────────
// No es lo mismo "el pago fue rechazado" que "no conseguimos intentarlo".
// Confundirlas baja de plan a un cliente que en realidad no debe nada, así que
// la decisión vive aquí, aislada y probada, y no dentro del bucle del cron.
//
//   retry_later → NO secobró nada por nuestra causa: límite de peticiones de
//                  QvaPay (429) o su servidor caído (5xx) o sin red. El
//                  cliente no se toca; se reintenta en la próxima corrida.
//   rejected    → QvaPay respondió que ese cobro no es posible: el usuario no
//                  autorizó, no existe, o no tiene saldo. Es un fallo real y el
//                  cliente sí debe enterarse.
export type ChargeOutcome = "retry_later" | "rejected";

export function classifyChargeFailure(err: unknown): ChargeOutcome {
  const status = typeof (err as any)?.status === "number" ? (err as any).status : null;
  if (status === 429) return "retry_later";                 // rate limit documentado
  if (status !== null && status >= 500) return "retry_later"; // problema de QvaPay
  if (status === null) return "retry_later";                // sin status = error de red
  return "rejected";                                        // 4xx: respuesta definitiva
}

// Decodifica el payload `data` (Base64 -> JSON) que manda QvaPay en el
// callback de authorize_payments. Confirmado con una autorización real:
// contiene remote_id, user_uuid, user_email, user_name, verified y
// auth_secret. auth_secret NO es necesario para /v2/charge según la doc
// oficial (que solo pide user_uuid) — lo guardamos igual por si acaso, pero
// no se usa en el cobro.
//
// `verified`: el payload real llega con "verified": true, pero NI la doc ni
// soporte explican qué significa. Decisión del dueño del producto: NO se usa
// como regla para rechazar suscripciones — si QvaPay lo cambiara o mandara
// false de pronto, bloquearíamos pagos legítimos sin saber por qué. Solo se
// registra en el log para seguir acumulando evidencia. Si algún día se
// confirma que es el KYC de QvaPay, lo correcto es avisarle al admin en el
// panel ("tu cuenta de QvaPay no está verificada"), no rechazar el callback.
export interface QvaPayCallbackData {
  remote_id?: string;
  user_uuid?: string;
  user_email?: string;
  user_name?: string;
  verified?: boolean;
  auth_secret?: string;
}

export function decodeQvapayCallbackData(dataB64: string): QvaPayCallbackData | null {
  try {
    const decoded = atob(dataB64);
    return JSON.parse(decoded) as QvaPayCallbackData;
  } catch {
    return null;
  }
}

export { QvaPayError };
