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
// firmado como esperamos. La documentación oficial de QvaPay NO detalla el
// formato del callback (data/token) ni cómo validarlo — lo que sabemos es
// solo lo observado en producción (data en Base64, token de 64 hex, que
// tiene pinta de HMAC-SHA256). Como no está confirmado por soporte/doc,
// esta función NO debe usarse para rechazar el callback todavía: solo para
// loguear si coincide, y así juntar evidencia antes de convertirlo en un
// bloqueo real. Si en varias pruebas reales el hash siempre coincide,
// entonces sí conviene endurecerlo a rechazo.
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

// Decodifica el payload `data` (Base64 -> JSON) que manda QvaPay en el
// callback de authorize_payments. Confirmado con una autorización real:
// contiene remote_id, user_uuid, user_email, user_name, verified y
// auth_secret. auth_secret NO es necesario para /v2/charge según la doc
// oficial (que solo pide user_uuid) — lo guardamos igual por si acaso, pero
// no se usa en el cobro.
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
