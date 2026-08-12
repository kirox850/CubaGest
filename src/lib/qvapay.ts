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

export { QvaPayError };
