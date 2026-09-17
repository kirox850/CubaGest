// Envío de correo vía Resend (https://resend.com) — plan gratis: 100/día,
// 3000/mes, sin costo. Requiere RESEND_API_KEY configurado como secret y el
// dominio remitente verificado en el panel de Resend (registros DNS).

export async function sendEmail(
  env: Env,
  params: { to: string; subject: string; html: string }
): Promise<{ sent: boolean; error?: string }> {
  if (!env.RESEND_API_KEY) {
    console.error("RESEND_API_KEY no configurado — no se pudo enviar correo a", params.to);
    return { sent: false, error: "Envío de correo no configurado" };
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.RESEND_FROM_EMAIL || "CubaGest <noreply@cubagest.dpdns.org>",
      to: [params.to],
      subject: params.subject,
      html: params.html,
    }),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.error("Error enviando correo via Resend:", res.status, errText);
    return { sent: false, error: errText || `Error ${res.status}` };
  }
  return { sent: true };
}

export function setPasswordEmailHtml(params: { name: string; url: string; isNewAccount: boolean }): string {
  const action = params.isNewAccount ? "establecer" : "restablecer";
  const heading = params.isNewAccount ? "Activa tu cuenta de CubaGest" : "Restablece tu contraseña";
  return `
    <div style="font-family: -apple-system, Arial, sans-serif; max-width: 480px; margin: 0 auto; color: #1E293B;">
      <h2 style="margin: 0 0 16px;">${heading}</h2>
      <p>Hola ${params.name},</p>
      <p>${params.isNewAccount
        ? "Te crearon una cuenta en CubaGest. Para activarla, elige tu propia contraseña:"
        : "Pediste restablecer tu contraseña en CubaGest. Elige una nueva:"
      }</p>
      <p style="margin: 24px 0;">
        <a href="${params.url}" style="background:#3B82F6;color:#ffffff;padding:12px 24px;border-radius:8px;text-decoration:none;display:inline-block;font-weight:600;">
          ${params.isNewAccount ? "Establecer contraseña" : "Restablecer contraseña"}
        </a>
      </p>
      <p style="color:#64748B;font-size:13px;">Este link vence en 48 horas y solo se puede usar una vez. Si no lo pediste tú, simplemente ignora este correo.</p>
      <p style="color:#94A3B8;font-size:12px;margin-top:24px;">Si el botón no funciona, copia y pega este link en tu navegador:<br/>${params.url}</p>
    </div>
  `;
}
