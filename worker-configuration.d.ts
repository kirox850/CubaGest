// Bindings del Worker, tipados.
//
// Este archivo lo genera `npx wrangler types`; esta es la versión a mano que
// estaba en el repo (y que nunca se incluía en el tsconfig, por lo que ningún
// typecheck había corrido nunca — ver `include` en tsconfig.json).
//
// Los secretos NO van aquí: van en `wrangler secret put`, y por eso todos los
// que no son structs públicos están marcados como opcionales.
interface Env {
  DB: D1Database;
  JWT_SECRET: string;
  ENVIRONMENT: string;

  QVAPAY_APP_ID?: string;
  QVAPAY_APP_SECRET?: string;
  QVAPAY_CALLBACK_URL?: string;
  APP_URL?: string;

  RESEND_API_KEY?: string;
  RESEND_FROM_EMAIL?: string;

  // Avisos del navegador (PWA). Para subirlos:
  //   npx wrangler secret put VAPID_PRIVATE_KEY
  //   npx wrangler secret put VAPID_PUBLIC_KEY
  // Se generan con `node scripts/gen-vapid-keys.mjs`.
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
  // Email de contacto que el navegador muestra junto a "suscrito". Mozilla y
  // Google lo exigen: sin él, el navegador rechaza la suscripción.
  VAPID_SUBJECT?: string;
}
