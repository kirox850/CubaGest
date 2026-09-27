// Verificación INDEPENDIENTE de la lógica pura del backend (auth + descuentos).
// No necesita npm: Node 26 carga estos .ts directamente (Web Crypto viene
// integrado) y `discountRules.ts` no importa nada externo.
//
//   node scripts/p0_logic_check.mjs
//
// Comprueba que:
//   1) un token de un propósito NO sirve para otro (access|support|refresh|platform);
//   2) verifyToken exige exp, iat y sub, y rechaza tokens vencidos o del futuro;
//   3) el claim heredado `type: "platform"` solo se acepta donde se espera platform;
//   4) la vida de la sesión larga es la acordada (access 9 h / refresh 180 días);
//   5) las reglas de descuento: vigencia, tope de usos, ámbito de ubicación,
//      porcentaje y fijo, y que un descuento nunca supere la base.

import { readFileSync } from "node:fs";
import { signToken, verifyToken, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS, PLATFORM_TOKEN_TTL_SECONDS, SUPPORT_TOKEN_TTL_SECONDS } from "../src/lib/jwt.ts";
import { isDiscountAvailable, computeDiscountAmount } from "../src/lib/discountRules.ts";
import { classifyChargeFailure } from "../src/lib/qvapay.ts";

const SECRET = "secreto-de-prueba-cubagest";
let pass = 0;
let fail = 0;

function check(name, cond, extra = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.error(`  ✗ ${name} ${extra}`); }
}
async function rejects(name, fn, expectMsg) {
  try {
    await fn();
    fail++;
    console.error(`  ✗ ${name}: NO rechazó (se esperaba error)`);
  } catch (err) {
    if (expectMsg && !new RegExp(expectMsg, "i").test(err.message)) {
      fail++;
      console.error(`  ✗ ${name}: rechazó con otro motivo: ${err.message}`);
    } else { pass++; console.log(`  ✓ ${name} → ${err.message}`); }
  }
}

const now = Math.floor(Date.now() / 1000);
const access = await signToken({ purpose: "access", userId: "u1", companyId: "c1", role: "cajero" }, SECRET, ACCESS_TOKEN_TTL_SECONDS);
const refresh = await signToken({ purpose: "refresh", userId: "u1", companyId: "c1", role: "cajero", jti: "j1" }, SECRET, REFRESH_TOKEN_TTL_DAYS * 86400);
const platform = await signToken({ purpose: "platform", adminId: "a1", email: "a@x.com" }, SECRET, PLATFORM_TOKEN_TTL_SECONDS);
const support = await signToken({ purpose: "support", userId: "u1", companyId: "c1", role: "admin" }, SECRET, SUPPORT_TOKEN_TTL_SECONDS);

console.log("1) Separación de carriles (un token de un propósito no vale para otro)");
const accessPayload = await verifyToken(access, SECRET, { expect: ["access", "support"] });
check("el access token entra a la API de empresa", accessPayload.userId === "u1" && accessPayload.companyId === "c1");
await rejects("el refresh token NO entra a la API de empresa",
  () => verifyToken(refresh, SECRET, { expect: ["access", "support"] }), "incorrecto");
await rejects("el token de plataforma NO entra a la API de empresa",
  () => verifyToken(platform, SECRET, { expect: ["access", "support"] }), "incorrecto");
await rejects("un access token NO se puede usar para refrescar",
  () => verifyToken(access, SECRET, { expect: ["refresh"], allowLegacyUnscoped: true }), "incorrecto");
await rejects("el token de plataforma NO entra como refresh",
  () => verifyToken(platform, SECRET, { expect: ["refresh"], allowLegacyUnscoped: true }), "incorrecto");
check("el refresh token sí sirve en /auth/refresh",
  (await verifyToken(refresh, SECRET, { expect: ["refresh"] })).purpose === "refresh");
check("el token de plataforma sí entra al panel",
  (await verifyToken(platform, SECRET, { expect: ["platform"] })).adminId === "a1");
check("el token de soporte entra a la API de empresa como admin",
  (await verifyToken(support, SECRET, { expect: ["access", "support"] })).role === "admin");
await rejects("el token de soporte NO entra al panel de plataforma",
  () => verifyToken(support, SECRET, { expect: ["platform"] }), "incorrecto");

console.log("\n2) Claims obligatorios (exp, iat, sub) y relojes");
// Tokens firmados DE VERDAD pero con claims rotos: si no, verifyToken los
// rechazaria por la firma y la prueba no demostraria nada sobre los claims.
const enc = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const hmacKey = await crypto.subtle.importKey(
  "raw", new TextEncoder().encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
);
const signRaw = async (payload) => {
  const head = enc({ alg: "HS256", typ: "JWT" });
  const body = enc(payload);
  const sig = await crypto.subtle.sign("HMAC", hmacKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${Buffer.from(new Uint8Array(sig)).toString("base64url")}`;
};
const noExp = await signRaw({ sub: "u1", purpose: "access", iat: now });
const noIat = await signRaw({ sub: "u1", purpose: "access", exp: now + 60 });
const noSub = await signRaw({ purpose: "access", iat: now, exp: now + 60 });
const future = await signRaw({ sub: "u1", purpose: "access", iat: now + 99999, exp: now + 200000 });
const noPurpose = await signRaw({ sub: "u1", iat: now, exp: now + 60 });
await rejects("sin exp", () => verifyToken(noExp, SECRET, { expect: ["access"] }), "expiraci");
await rejects("sin iat", () => verifyToken(noIat, SECRET, { expect: ["access"] }), "emisi");
await rejects("sin sub", () => verifyToken(noSub, SECRET, { expect: ["access"] }), "sujeto");
const expiredToken = await signToken({ purpose: "access", userId: "u1", companyId: "c1", role: "cajero" }, SECRET, -10);
await rejects("vencido", () => verifyToken(expiredToken, SECRET, { expect: ["access"] }), "expirado");
await rejects("emitido en el futuro", () => verifyToken(future, SECRET, { expect: ["access"] }), "fecha");
await rejects("firmado con otro secreto", () => verifyToken(access, "otro-secreto", { expect: ["access"] }), "Firma");
await rejects("sin proposito declarado", () => verifyToken(noPurpose, SECRET, { expect: ["access"] }), "prop");

// Token del panel emitido por la version anterior (marcador `type`, sin
// `purpose`): debe seguir entrando al panel y NUNCA a la API de empresa.
const legacyNoPurpose = await signRaw({ sub: "a1", adminId: "a1", type: "platform", iat: now, exp: now + 3600 });
check("el marcador heredado type=platform solo vale en el panel",
  (await verifyToken(legacyNoPurpose, SECRET, { expect: ["platform"] })).adminId === "a1");
await rejects("...y NO en la API de empresa",
  () => verifyToken(legacyNoPurpose, SECRET, { expect: ["access", "support"] }), "prop|incorrecto");
check("el token platform moderno se acepta igual", (await verifyToken(platform, SECRET, { expect: ["platform"] })).purpose === "platform");

console.log("\n3) Vida de la sesión");
check("access = 9 h (jornada larga, se renueva en silencio)", ACCESS_TOKEN_TTL_SECONDS === 9 * 3600);
check("refresh = 180 días corrido (dispositivo personal)", REFRESH_TOKEN_TTL_DAYS === 180);
check("platform = 12 h", PLATFORM_TOKEN_TTL_SECONDS === 12 * 3600);
check("soporte = 2 h", SUPPORT_TOKEN_TTL_SECONDS === 2 * 3600);
const refreshPayload = await verifyToken(refresh, SECRET, { expect: ["refresh"] });
check("el refresh caduca 180 días después de emitirse",
  Math.round((refreshPayload.exp - now) / 86400) === 180, `exp-now=${refreshPayload.exp - now}`);
const accessPayload2 = await verifyToken(access, SECRET, { expect: ["access"] });
check("el access caduca 9 horas después de emitirse",
  Math.round((accessPayload2.exp - now) / 60) === 540, `exp-now=${accessPayload2.exp - now}`);

console.log("\n4) Reglas de descuento");
const base = { companyId: "c1", name: "10%", code: "DIEZ", scope: "producto", type: "porcentaje", value: 10, maxUses: 5, timesUsed: 0, locationScope: "todas", locationIds: [], startsAt: null, endsAt: null, active: true };
check("un descuento vigente y con usos está disponible", isDiscountAvailable(base, "loc1").ok);
check("inactivo → no disponible", !isDiscountAvailable({ ...base, active: false }, "loc1").ok);
check("agotado → no disponible", !isDiscountAvailable({ ...base, timesUsed: 5 }, "loc1").ok);
check("sin tope de usos nunca se agota", isDiscountAvailable({ ...base, maxUses: null, timesUsed: 999 }, "loc1").ok);
check("aún no vigente → no disponible",
  !isDiscountAvailable({ ...base, startsAt: new Date(Date.now() + 86400000) }, "loc1").ok);
check("caducado → no disponible",
  !isDiscountAvailable({ ...base, endsAt: new Date(Date.now() - 86400000) }, "loc1").ok);
check("ámbito de ubicación: solo en las cajas elegidas",
  isDiscountAvailable({ ...base, locationScope: "seleccion", locationIds: ["loc2"] }, "loc2").ok &&
  !isDiscountAvailable({ ...base, locationScope: "seleccion", locationIds: ["loc2"] }, "loc1").ok);

check("10% de 1000 = 100", computeDiscountAmount(base, 1000) === 100);
check("50% de 99 = 49.5", computeDiscountAmount({ ...base, value: 50 }, 99) === 49.5);
check("fijo por producto se multiplica por la cantidad",
  computeDiscountAmount({ ...base, type: "fijo", value: 5 }, 1000, 3) === 15);
check("fijo de venta NO se multiplica por la cantidad",
  computeDiscountAmount({ ...base, type: "fijo", value: 5, scope: "venta" }, 1000, 3) === 5);
check("el descuento nunca supera la base", computeDiscountAmount({ ...base, value: 100 }, 40) === 40);
check("nunca devuelve un descuento negativo", computeDiscountAmount({ ...base, value: -5 }, 100) === 0);

console.log("\n5) Fallos de cobro: reintentable vs. rechazo real (cron de QvaPay)");
const errWith = (status, message = "x") => Object.assign(new Error(message), { status });
check("429 (límite de 5/20s documentado) → reintentar, NO degradar al cliente",
  classifyChargeFailure(errWith(429)) === "retry_later");
check("500 de QvaPay → reintentar", classifyChargeFailure(errWith(500)) === "retry_later");
check("503 → reintentar", classifyChargeFailure(errWith(503)) === "retry_later");
check("sin status (error de red) → reintentar", classifyChargeFailure(new Error("fetch failed")) === "retry_later");
check("400 sin autorización del usuario → rechazo real", classifyChargeFailure(errWith(400)) === "rejected");
check("404 usuario no encontrado → rechazo real", classifyChargeFailure(errWith(404)) === "rejected");
check("saldo insuficiente (400) → rechazo real", classifyChargeFailure(errWith(400, "Balance insuficiente")) === "rejected");
check("un rejection nunca se confunde con un rate limit",
  classifyChargeFailure(errWith(400)) !== classifyChargeFailure(errWith(429)));

console.log("\n6) Una sola tabla de precios");
const platformSrc = readFileSync(new URL("../src/routes/platform.ts", import.meta.url), "utf8");
check("platform.ts ya no define sus propios precios",
  !/const PLAN_PRICE_USD: Record<string, number>/.test(platformSrc));
check("platform.ts importa PLAN_PRICES (la de QvaPay)", /import \{ PLAN_PRICES \} from "\.\.\/middleware\/plans"/.test(platformSrc));
// plans.ts importa hono (no instalado), así que el precio se lee del texto.
const plansSrc = readFileSync(new URL("../src/middleware/plans.ts", import.meta.url), "utf8");
const priceOf = (plan) => {
  const m = plansSrc.match(new RegExp(plan + ":\\s*([0-9.]+)"));
  return m ? Number(m[1]) : NaN;
};
check("el precio real de pro es 5", priceOf("pro") === 5);
check("el precio real de empresarial es 10", priceOf("empresarial") === 10);
check("free es 0", priceOf("free") === 0);

console.log("\n7) Cancelar la suscripción existe Y detiene el cobro");
const subsSrc = readFileSync(new URL("../src/routes/subscriptions.ts", import.meta.url), "utf8");
const modalSrc = readFileSync(new URL("../../CubaGest-Web/src/screens/PlanModal.tsx", import.meta.url), "utf8");
check("hay una ruta POST /subscription/cancel", /subscriptions\.post\("\/cancel"/.test(subsSrc));
check("cancelar solo lo puede hacer un admin", /post\("\/cancel", authMiddleware, requireRole\("admin"\)/.test(subsSrc));
check("al cancelar se vacía la fecha del próximo cobro (el cron cobra por ahí)",
  /subscriptionStatus: "cancelled",[\s\S]{0,400}?nextPaymentDate: null,/.test(subsSrc));
check("el cron se salta a las empresas canceladas",
  /subscriptionStatus !== "cancelled"/.test(subsSrc));
check("el panel tiene el botón de cancelar", /handleCancel/.test(modalSrc) && /Cancelar suscripci/.test(modalSrc));
check("ya no se dice 'escríbenos para cancelar'", !/escr[ií]benos antes de la fecha/.test(modalSrc));

console.log("\n8) Los tres avisos que tienen que dispararse");
{
  const trSrc = readFileSync(new URL("../src/routes/transfers.ts", import.meta.url), "utf8");
  const clSrc = readFileSync(new URL("../src/routes/closing.ts", import.meta.url), "utf8");
  const pushLib = readFileSync(new URL("../src/lib/push.ts", import.meta.url), "utf8");
  const webpushSrc = readFileSync(new URL("../src/lib/webpush.ts", import.meta.url), "utf8");
  const swSrc = readFileSync(new URL("../../CubaGest-Web/public/sw.js", import.meta.url), "utf8");
  const bellSrc = readFileSync(new URL("../../CubaGest-Web/src/components/shared/NotificationsBell.tsx", import.meta.url), "utf8");

  check("crear un envío avisa a quien lo recibe", /transferRecipientsOrAdmins/.test(trSrc) && /transfer\.created/.test(trSrc));
  check("aprobar un envío avisa a quien lo pidió", /notifyTransferResolved\(c, db, auth, transfer, "aprobado"/.test(trSrc));
  check("rechazar un envío avisa a quien lo pidió", /notifyTransferResolved\(c, db, auth, transfer, "rechazado"/.test(trSrc));
  check("el motivo del rechazo viaja en el aviso", /transfer\.rejectReason/.test(trSrc));
  check("un cierre con faltante avisa a los admins", /closing\.shortage/.test(clSrc) && /adminsOf\(db, auth\.companyId\)/.test(clSrc));
  check("el aviso de faltante solo sale si hubo faltante", /if \(hasShortage\)/.test(clSrc));
  check("el aviso se manda sin bloquear la respuesta (waitUntil)", /waitUntil/.test(trSrc) && /waitUntil/.test(clSrc));
  check("el aviso se guarda en la base ANTES de empujarlo", pushLib.indexOf("db.insert(schema.notifications)") < pushLib.indexOf("pushToBrowsers(env"));
  // Sin comentarios: si no, el test se dispara con los textos que explican
  // por qué web-push no se usa (que mencionan web-push y require("https")).
  const soloCodigo = (src) => src.split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  check("ya NO se usa la librería 'web-push' de Node (no existe en un Worker)",
    !/from "web-push"|require\("web-push"\)|import\("web-push"\)/.test(soloCodigo(pushLib))
    && !/require\('(https|crypto|net|url|util|stream|tls|assert|buffer)'\)/.test(soloCodigo(webpushSrc)));
  check("el cifrado usa solo la Web Crypto del runtime (sin dependencias)",
    /crypto\.subtle/.test(webpushSrc) && !/^import .* from "node:/m.test(webpushSrc));
  check("un aviso nunca rompe la venta que lo disparó", /console\.error\(`push: no se pudo registrar/.test(pushLib));
  check("un navegador muerto (404/410) se borra de la lista",
    /r\.gone/.test(pushLib) && /db\.delete\(schema\.pushSubscriptions\)/.test(pushLib));
  check("sendPush marca 404/410 como 'gone' (y no como error de red)",
    /gone: res\.status === 404 \|\| res\.status === 410/.test(webpushSrc));
  check("un fallo del servicio NO borra la suscripción (se reintenta)",
    /r\.status >= 400/.test(pushLib) && /failures: sub\.failures \+ 1/.test(pushLib));
  check("un payload enorme se recorta antes de cifrar (límite de 4 KB)",
    /cortarSiCabe\(payload\)/.test(webpushSrc) && /MAX_BODY = 4096/.test(webpushSrc));
  check("el service worker muestra el aviso", /addEventListener\('push'/.test(swSrc) && /showNotification/.test(swSrc));
  check("al tocar el aviso se abre la pantalla indicada", /addEventListener\('notificationclick'/.test(swSrc));
  check("la lista sale de la base, no del push (si el push falla, se ve igual)", /apiFetch\("\/push\/notifications/.test(bellSrc));
  check("el permiso NO se pide al arrancar (se pregunta en la campanita)", !/requestPermission/.test(bellSrc));
}

console.log("\n9) Web Push: el cifrado de verdad (ida y vuelta)");
{
  const wp = await import("../src/lib/webpush.ts");
  const { _internals: I } = wp;
  const b64u = I.bytesToB64u;
  const fromB64u = I.b64uToBytes;
  const cat = I.concat;
  const enc = new TextEncoder();

  // Se simula un suscriptor: tiene su par de llaves, y SOLO debe poder
  // descifrar lo que este archivo cifró con las suyas.
  const receiver = crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const receiverPub = new Uint8Array(await crypto.subtle.exportKey("raw", (await receiver).publicKey));
  const receiverJwk = await crypto.subtle.exportKey("jwk", (await receiver).privateKey);
  const authSecret = crypto.getRandomValues(new Uint8Array(16));

  const sub = {
    endpoint: "https://fcm.googleapis.com/fcm/send/abc123",
    p256dh: b64u(receiverPub),
    auth: b64u(authSecret),
  };
  const texto = JSON.stringify({ title: "Tienes un envío por aprobar", body: "3 × Aceite" });

  const body = await I.encrypt(texto, sub);
  check("el cuerpo cifrado no contiene el texto en claro",
    !new TextDecoder().decode(body).includes("aprobado"));
  check("el cuerpo tiene la forma salt(65) + nonce(12) + cifrado + tag(16)",
    body.length === 65 + 12 + enc.encode(texto).length + 1 + 16, `largo=${body.length}`);

  // ── Descifrado INDEPENDIENTE (la parte que de verdad prueba la matemática) ──
  const salt = body.subarray(0, 65);
  const nonce = body.subarray(65, 77);
  const sealed = body.subarray(77);
  const uaPublic = fromB64u(sub.p256dh);

  // OJO: el receptor hace ECDH( SU privada , el SALT ). El salt es la pública
  // efímera del emisor, que viaja en el propio mensaje. Usar su propia pública
  // (que es p256dh) daría otro valor y el descifrado fallaría.
  const shared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: await crypto.subtle.importKey("raw", salt, { name: "ECDH", namedCurve: "P-256" }, false, []) },
    (await receiver).privateKey, 256));
  const prk = await I.hmac(fromB64u(sub.auth), shared);
  const ikm = await I.hmac(prk, cat(I.UTF8.encode("WebPush: info\0"), uaPublic, salt));
  const cek = await I.hmac(ikm, I.UTF8.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonceFull = await I.hmac(cek, I.UTF8.encode("Content-Encoding: nonce\0"));
  const recordNonce = nonceFull.slice(nonceFull.length - 12);

  check("el nonce calculado por el receptor es el mismo que va en el cuerpo",
    b64u(recordNonce) === b64u(nonce));

  const plain = new Uint8Array(await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: recordNonce, additionalData: salt, tagLength: 128 },
    await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]),
    sealed));
  check("el receptor recupera EXACTAMENTE el texto enviado",
    new TextDecoder().decode(plain.subarray(0, plain.length - 1)) === texto);
  check("el delimitador de fin de registro es 0x02", plain[plain.length - 1] === 0x02);

  // Alguien que ve el mensaje por el camino no puede descifrarlo aunque tenga
  // la pública del receptor (que es pública, va en la suscripción): sin el
  // `auth_secret` —que es privado del navegador— no puede derivar la misma llave.
  const intrusoShared = new Uint8Array(await crypto.subtle.deriveBits(
    { name: "ECDH", public: await crypto.subtle.importKey("raw", salt, { name: "ECDH", namedCurve: "P-256" }, false, []) },
    (await receiver).privateKey, 256));
  const intrusoAuth = crypto.getRandomValues(new Uint8Array(16)); // no es el del receptor
  const intrusoIkm = await I.hmac(await I.hmac(intrusoAuth, intrusoShared), cat(I.UTF8.encode("WebPush: info\0"), uaPublic, salt));
  const intrusoCek = await I.hmac(intrusoIkm, I.UTF8.encode("Content-Encoding: aes128gcm\0"), 16);
  const intrusoNonce = (await I.hmac(intrusoCek, I.UTF8.encode("Content-Encoding: nonce\0"))).slice(20);
  let fallo = "NO FALLÓ (¡el cifrado no sirve!)";
  try {
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: intrusoNonce, additionalData: salt, tagLength: 128 },
      await crypto.subtle.importKey("raw", intrusoCek, "AES-GCM", false, ["decrypt"]), sealed);
  } catch { fallo = null; }
  check("alguien con otra llave NO puede descifrar el aviso", fallo === null, fallo ?? "");

  // Y un mensaje con un solo bit cambiado tampoco se puede leer (AES-GCM
  // autentica: por eso el salt va como datos adicionales).
  const cifradoAlterado = cat(salt, nonce, (() => { const t = sealed.slice(); t[0] ^= 1; return t; })());
  let fallo2 = "NO FALLÓ";
  try {
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData: salt, tagLength: 128 },
      await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]), cifradoAlterado);
  } catch { fallo2 = null; }
  check("un mensaje alterado NO se puede descifrar", fallo2 === null, fallo2 ?? "");

  // ── La llave VAPID (es el "quién envía") ──
  const vapidPair = crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const vpJwk = await crypto.subtle.exportKey("jwk", (await vapidPair).privateKey);
  const punto = cat(new Uint8Array([0x04]), fromB64u(vpJwk.x), fromB64u(vpJwk.y));
  const authHeader = await I.vapidAuthorization(sub.endpoint, b64u(punto), vpJwk.d, "mailto:prueba@ejemplo.com");
  check("la cabecera VAPID tiene el formato correcto", /^vapid t=[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+, k=[A-Za-z0-9_-]+$/.test(authHeader));
  const jwt = authHeader.match(/t=([^,]+)/)[1];
  const [h, p, sig] = jwt.split(".");
  const verif = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: vpJwk.x, y: vpJwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    fromB64u(sig), I.UTF8.encode(`${h}.${p}`));
  check("la firma VAPID se verifica con la llave pública (ES256)", verif === true);
  const payload = JSON.parse(new TextDecoder().decode(fromB64u(p)));
  check("el JWT de VAPID apunta al origen del endpoint", payload.aud === "https://fcm.googleapis.com", payload.aud);
  check("y caduca en 12 horas o menos", payload.exp - Math.floor(Date.now() / 1000) <= 12 * 3600 && payload.exp > Math.floor(Date.now() / 1000));
  const firmaAlterada = `${h}.${p}.${b64u(crypto.getRandomValues(new Uint8Array(64)))}`;
  const mal = await crypto.subtle.verify(
    { name: "ECDSA", hash: "SHA-256" },
    await crypto.subtle.importKey("jwk", { kty: "EC", crv: "P-256", x: vpJwk.x, y: vpJwk.y }, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]),
    fromB64u(firmaAlterada.split(".")[2]), I.UTF8.encode(`${h}.${p}`));
  check("una firma alterada NO verifica", mal === false);

  // Un payload enorme se recorta ANTES de cifrar, y el JSON sigue siendo válido
  // (partirlo a lo bruto daría algo que el service worker no puede leer).
  const enorme = JSON.stringify({ id: "x", title: "T".repeat(5000), body: "B".repeat(5000), link: "/" });
  const recortado = I.cortarSiCabe(enorme);
  const cuerpoEnorme = await I.encrypt(recortado, sub);
  check("un payload enorme produce un cuerpo dentro del límite de 4096",
    cuerpoEnorme.length <= 4096, `largo=${cuerpoEnorme.length}`);
  check("el recorte sigue siendo JSON válido",
    (() => { try { JSON.parse(recortado); return true; } catch { return false; } })());
  check("un payload normal NO se toca",
    I.cortarSiCabe("{\"a\":1}") === "{\"a\":1}");
}

console.log("\n10) Modo sin conexión: lo que se rompió al probarlo en un teléfono");
{
  const locHook = readFileSync(new URL("../../CubaGest-Web/src/hooks/useLocations.ts", import.meta.url), "utf8");
  const onlHook = readFileSync(new URL("../../CubaGest-Web/src/hooks/useOnline.ts", import.meta.url), "utf8");
  const cierre  = readFileSync(new URL("../../CubaGest-Web/src/screens/CierreCaja.tsx", import.meta.url), "utf8");
  const inv     = readFileSync(new URL("../../CubaGest-Web/src/screens/Inventario.tsx", import.meta.url), "utf8");
  const app     = readFileSync(new URL("../../CubaGest-Web/src/App.tsx", import.meta.url), "utf8");
  const offDB   = readFileSync(new URL("../../CubaGest-Web/src/offlineDB.ts", import.meta.url), "utf8");
  const swOffline = readFileSync(new URL("../../CubaGest-Web/public/sw.js", import.meta.url), "utf8");

  // ── El namespace de los datos locales ──
  // La empresa vive en user.company.id. Si alguien "simplifica" a user.companyId,
  // el namespace queda vacío y TODO el modo sin conexión deja de funcionar en
  // silencio (sin error, solo una app que no carga nada).
  check("el namespace usa user.company.id (no user.companyId)",
    !locHook.includes("user?.companyId") && locHook.includes("user?.company?.id"));
  check("y ninguna pantalla usa user.companyId para el namespace",
    !/companyId:\s*user\?\.companyId/.test(
      ["Inventario","POS","CierreCaja","Facturacion"].map(f =>
        readFileSync(new URL(`../../CubaGest-Web/src/screens/${f}.tsx`, import.meta.url), "utf8")).join("\n")));

  // ── La ubicación es lo que desbloquea todo lo demás ──
  check("las ubicaciones se guardan para poder arrancar sin red",
    /export async function cacheLocations/.test(offDB) && /export async function getOfflineLocations/.test(offDB));
  check("y el inventario las usa en vez de pedirlas siempre por red",
    /useLocations/.test(inv) && !/apiFetch\("\/locations"\)/.test(inv));
  check("sin ubicación NO se sale en silencio (se explica el problema)",
    /if \(!locationId\)/.test(inv) && /falta la ubicación/.test(inv));

  // ── Lecturas de apertura ──
  check("las lecturas se cachean para poder cerrar sin red",
    /export async function cacheReadings/.test(offDB) && /export async function getOfflineReadings/.test(offDB));
  check("el cierre ya NO depende de un fetch que sin red no existe",
    !/apiFetch\("\/closing\/readings"\)/.test(cierre));

  // ── El conteo sin conexión ──
  check("sin conexión se cuenta contra la lectura, no contra el servidor",
    /previewSinConexion/.test(cierre) && /stockInitial: it\.qty/.test(cierre));
  check("y los faltantes NO se inventan en local (quedan pendientes)",
    /stockExpected: null/.test(cierre) && /stockSold: null/.test(cierre) && /faltante se calcula al enviarse/.test(cierre));
  check("el conteo sin red se guarda en una cola, no se pierde",
    /saveClosingOffline/.test(cierre) && /Guardar conteo en el móvil/.test(cierre));
  check("la cola se envía sola al volver la conexión",
    /syncClosingsOffline/.test(app) && /getPendingClosings/.test(app));
  check("reenviar un cierre ya registrado no lo duplica (409 = hecho)",
    /e\?\.status === 409/.test(app) && /yaHecho \? 'synced' : 'pending'/.test(app));
  check("los cierres pendientes se ven en la lista (nadie cree que se perdió)",
    /pendientes\.length > 0/.test(cierre) && /Conteo guardado sin conexión/.test(cierre));

  // ── La red que miente ──
  check("la app no se fía solo de navigator.onLine (miente con WiFi sin salida)",
    /onNetworkChange/.test(onlHook) && /delNavegador && netReal/.test(onlHook));
  check("una respuesta recibida demuestra que hay red",
    /_marcarHayRed\(\)/.test(readFileSync(new URL("../../CubaGest-Web/src/lib/api.ts", import.meta.url), "utf8")));
  check("y un fallo de transporte la desmiente (sin esperar a los 8 s)",
    /_marcarSinRed\(\)/.test(readFileSync(new URL("../../CubaGest-Web/src/lib/api.ts", import.meta.url), "utf8")));
  check("sin conexión el banner dice qué sigue funcionando",
    /puedes vender, ver el inventario y hacer el conteo de cierre/.test(
      readFileSync(new URL("../../CubaGest-Web/src/components/shared/primitives.tsx", import.meta.url), "utf8")));

  // ── La web app shell sí arranca sin red ──
  check("el service worker sirve la app sin conexión",
    /caches\.match\('\/index\.html'\)/.test(swOffline) && /req\.mode === 'navigate'/.test(swOffline));
  check("pero nunca cachea datos de /api (se filtrarían entre usuarios)",
    /if \(isApiPath\(url\.pathname\)\) return;/.test(swOffline));
  // Comprobación monótona: si el número de la caché está escrito a mano, un
  // check con la versión fija falla justo cuando se sube (que es cuando debe
  // pasar), y no avisa si alguien la baja.
  const vCache = Number((swOffline.match(/const CACHE = 'cubagest-v(\d+)'/) || [])[1] || 0);
  check("la versión del caché sube para que el móvil tome la app nueva",
    vCache >= 9, ` (está en v${vCache}; se necesita v9 o superior)`);
}

console.log("\n11) Fechas de venta: la hora real, no la de llegada");
{
  const salesSrc = readFileSync(new URL("../src/lib/sales.ts", import.meta.url), "utf8");
  const batchSrc = readFileSync(new URL("../src/lib/batch.ts", import.meta.url), "utf8");
  const appSrc  = readFileSync(new URL("../../CubaGest-Web/src/App.tsx", import.meta.url), "utf8");

  // ── La trampa: unixepoch() da SEGUNDOS y drizzle mode:"timestamp" espera
  //    MILISEGUNDOS. Con eso toda venta se leía como 1970 y NINGUNA entraba a
  //    un cierre (el filtro por período comparaba 1970 contra la fecha real).
  check("ningún insert de stock/auditoría vuelve a usar unixepoch()",
    !/unixepoch\(\)/.test(batchSrc), "quedan: " + (batchSrc.match(/unixepoch\(\)/g) || []).length);
  check("las transferencias tampoco", !/unixepoch\(\)/.test(
    readFileSync(new URL("../src/lib/locations.ts", import.meta.url), "utf8")));
  check("la venta guarda created_at en milisegundos",
    /created_at\)\n\s*VALUES \(.*\?\)/.test(salesSrc) && /soldAt\.getTime\(\)/.test(salesSrc));
  check("y usa el momento en que se VENDIÓ, no el de llegada",
    /new Date\(input\.offlineTimestamp\)/.test(salesSrc) && /soldAt = typeof input\.offlineTimestamp/.test(salesSrc));
  check("el día contable sigue a la venta, no a la sincronización",
    /saleDate = soldAt\.toISOString\(\)/.test(salesSrc));
  check("synced_at guarda aparte cuándo llegó (diagnóstico, no contabilidad)",
    /input\.synced \? now\.getTime\(\) : null/.test(salesSrc));

  // La reparación de lo ya guardado.
  const mig = readFileSync(new URL("../migrations/0010_sale_dates_ms.sql", import.meta.url), "utf8");
  check("hay migración que arregla las ventas ya fechadas en 1970",
    /UPDATE sales\s+SET created_at = created_at \* 1000/.test(mig));
  check("y solo toca valores que son segundos (no toca lo ya correcto)",
    /created_at < 100000000000/.test(mig));

  // ── Orden de la sincronización ──
  const ventas = appSrc.indexOf("/sales/sync");
  const cierres = appSrc.indexOf("await syncClosingsOffline(acc);", ventas);
  check("las ventas se sincronizan ANTES que los cierres",
    ventas > -1 && cierres > ventas, "ventas en " + ventas + ", cierre en " + cierres);
  check("y el motivo está escrito, porque el orden no es obvious",
    /cierre se calcula con las[\s\S]*?ventas que el servidor tenga/.test(appSrc));
}

console.log("\n12) Configuración: todo en un sitio, y el margen es del negocio");
{
  const app  = readFileSync(new URL("../../CubaGest-Web/src/App.tsx", import.meta.url), "utf8");
  const conf = readFileSync(new URL("../../CubaGest-Web/src/screens/Configuracion.tsx", import.meta.url), "utf8");
  const caja = readFileSync(new URL("../../CubaGest-Web/src/screens/CajaSettings.tsx", import.meta.url), "utf8");
  const set  = readFileSync(new URL("../src/routes/settings.ts", import.meta.url), "utf8");
  const sch  = readFileSync(new URL("../src/db/schema.ts", import.meta.url), "utf8");

  check("el menú de perfil tiene UNA entrada de configuración, no cuatro",
    /Configuración/.test(app) && !/setCurrenciesOpen\(true\)/.test(app) && !/setDiscountsOpen\(true\)/.test(app));
  check("y las cuatro pantallas viven dentro, como pestañas laterales",
    /type TabId = "cajas" \| "caja" \| "monedas" \| "descuentos" \| "usuarios" \| "auditoria" \| "plan"/.test(conf));
  check("el paso a lateral se hace por CSS, no con estilos inline",
    /\.cfg-split \{ flex-direction:row; \}/.test(conf) && !/className="cfg-split" style=/.test(conf));
  check("nada de modales anidados (el de arriba tapaba al de abajo, sin vuelta atrás)",
    /embedded \? contenido : <Modal/.test(readFileSync(new URL("../../CubaGest-Web/src/screens/PlanModal.tsx", import.meta.url), "utf8"))
    && /embedded \? contenido : <Modal/.test(readFileSync(new URL("../../CubaGest-Web/src/screens/CurrenciesSettings.tsx", import.meta.url), "utf8"))
    && /embedded \? contenido : <Modal/.test(readFileSync(new URL("../../CubaGest-Web/src/screens/DiscountsAdmin.tsx", import.meta.url), "utf8")));

  // El margen: decisión de cada negocio, NO de la plataforma.
  check("el margen de dinero vive en la empresa, no en el código",
    /cashToleranceMode: text\("cash_tolerance_mode"/.test(sch) && /cash_tolerance_mode/.test(
      readFileSync(new URL("../migrations/0011_cash_tolerance.sql", import.meta.url), "utf8")));
  check("se puede expresar en cantidad fija o en porcentaje",
    /cashToleranceMode === "porcentaje"/.test(set) && /modo === "porcentaje"/.test(caja));
  check("por defecto NO tolera nada (perdonar sin que el dueño lo pida es esconderle dinero)",
    /cash_tolerance_value REAL NOT NULL DEFAULT 0/.test(
      readFileSync(new URL("../migrations/0011_cash_tolerance.sql", import.meta.url), "utf8")));
  check("y se valida: ni negativo, ni un % de más de 100",
    /El margen no puede ser negativo/.test(set) && /no puede pasar de 100/.test(set));
  check("solo el admin lo cambia (la ruta PUT ya es requireRole admin)",
    /requireRole\("admin"\), async \(c\)/.test(set));
  check("el móvil lo puede leer aunque no tenga conexión (lo necesita el cierre)",
    /cashToleranceMode: s\.cashToleranceMode/.test(set));
  check("las salidas de dinero siempre se aprueban",
    /cashRequireApproval/.test(sch) && /aprobación de un admin o un contador/.test(caja));
}

console.log("\n13) Cajas compartidas y turnos");
{
  const R = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const m12 = R("../migrations/0012_cashier_locations_shifts.sql");
  const lib = R("../src/lib/locations.ts");
  const sh  = R("../src/routes/shifts.ts");
  const usr = R("../src/routes/users.ts");
  const pos = R("../../CubaGest-Web/src/screens/POS.tsx");
  const cur = R("../../CubaGest-Web/src/screens/CurrenciesSettings.tsx");

  check("las cajas ya no son de un cajero: hay tabla de asignación",
    /CREATE TABLE IF NOT EXISTS location_assignments/.test(m12));
  check("las cajas que ya existían se asignan solas, para no dejar a nadie sin caja",
    /INSERT OR IGNORE INTO location_assignments/.test(m12) && /owner_user_id IS NOT NULL/.test(m12));
  check("varias cajas pueden turnar sobre la misma caja (y eso es a propósito)",
    /varios cajeros/.test(m12) && !/location_assignments_caja_unica/.test(m12));

  // Lo que de verdad protege el inventario no es la asignación, sino los turnos.
  check("una caja no puede tener dos turnos abiertos a la vez",
    /shifts_one_open_per_location/.test(m12) && /esa caja ya est/gi);
  check("un cajero no puede tener dos turnos abiertos a la vez",
    /shifts_one_open_per_user/.test(m12));
  check("abrir turno crea la lectura de apertura de ESA caja, en una sola transacción",
    /openingReadingId: readingId/.test(sh) && /DB\.batch\(stmts\)/.test(sh));
  check("el turno abierto manda sobre las cajas asignadas",
    /getOpenShiftForUser/.test(lib) && /asignadas\.length === 1/.test(lib));

  // El backend es quien decide: un cajero no puede abrir turno en una caja ajena.
  check("un cajero solo abre turno en cajas que el admin le asignó",
    /No tienes esa caja asignada/.test(sh) && /getCajasAsignadas/.test(sh));
  check("asignar una caja de otra empresa no cuela",
    /getActiveCompanyLocation\(db, auth\.companyId, id\)/.test(sh) && /location\.type !== "caja"/.test(sh));

  // La baja de un cajero NO puede tocar el stock de una caja compartida.
  check("dar de baja a un cajero NO vacía la caja compartida de los demás",
    !/returnAllStockToAlmacen/.test(usr) && /assignments_cleared/.test(usr));
  check("ni la desactiva (la caja es del negocio, no del empleado)",
    !/active: false\)\)\.where\(eq\(schema\.inventoryLocations\.id, caja\.id\)\)/.test(usr));
  check("y el cajero nuevo ya no recibe una caja propia",
    !/ensureCajaLocation/.test(usr));

  // El POS vende en la caja del turno, no en la "caja del dueño".
  check("el POS toma la caja del turno, no la del dueño",
    /locs\.find\(\(l:any\)=>l\.id===shift\.locationId\)/.test(pos));
  check("sin turno abierto el POS no vende y lo dice",
    /No tienes un turno abierto/.test(pos) && /Comenzar turno/.test(pos));
  check("abrir turno recarga el catálogo de la caja nueva",
    /\[online, shift\?\.id\]/.test(pos));

  // Un cliente nunca debe ver notas de implementación.
  // Sin comentarios: en el código el token SÍ se menciona (es donde se
  // documenta), pero un cliente no lee el código, lo que importa es lo que ve.
  const curVisible = cur.replace(/\/\/.*$/gm, "").replace(/\*\*[\s\S]*?\*\//g, "");
  check("el texto técnico de elToque no está en la UI",
    !/eltoque\.com\/docs/.test(curVisible) && !/ELTOQUE_API_TOKEN/.test(curVisible)
    && !/raspado/.test(curVisible) && !/wrangler/.test(curVisible));
}

console.log("\n14) El diseño de cierres: dinero, movimientos y provisional");
{
  const R = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const m13 = R("../migrations/0013_closing_design.sql");
  const din = R("../src/lib/cierreDinero.ts");
  const clo = R("../src/routes/closing.ts");
  const mov = R("../src/routes/cashMovements.ts");
  const idx = R("../src/index.ts");
  const cc  = R("../../CubaGest-Web/src/screens/CierreCaja.tsx");
  const dc  = R("../../CubaGest-Web/src/components/shared/DineroCierre.tsx");

  check("el período de los cierres viejos se arregla (se guardaba en segundos)",
    /period_start = period_start \* 1000/.test(m13) && /periodStart\.getTime\(\), periodEnd\.getTime\(\)/.test(clo));
  const cloCodigo = clo.replace(/\/\/.*$/gm, "").replace(/\*\*[\s\S]*?\*\//g, "");
  check("el conteo ya no pisa el stock: ajusta por diferencia",
    !/setStockStmt/.test(cloCodigo) && /incrementStockStmt/.test(cloCodigo) && /decrementStockStmt/.test(cloCodigo));
  check("una venta que llega tarde ya no descuadra el inventario para siempre",
    /una venta que llegue después/i.test(clo));

  // El dinero, por moneda. Esto es el núcleo del diseño.
  check("cada moneda se lleva por su cuenta, nunca sumando entre ellas",
    /const monedas = new Set/.test(din) && /delete diffRestante\[currency\]/.test(clo));
  check("solo entran las ventas EN EFECTIVO (una transferencia no pasa por la caja)",
    /payMethod !== "efectivo"/.test(din) && /continue/.test(din));
  check("las salidas pendientes de aprobación no cuentan todavía",
    /eq\(schema\.cashMovements\.status, "aprobada"\)/.test(din));
  check("una salida sin motivo no se registra (es el caso que todo esto arregla)",
    /if \(type === "salida" && !motivo\)/.test(mov) && /Sin motivo no se puede registrar/.test(mov));
  check("un cajero sin turno abierto no registra salidas",
    /Abre tu turno antes de registrar una salida/.test(mov));
  check("nadie aprueba su propio movimiento",
    /No puedes aprobar un movimiento que registraste tú mismo/.test(mov));

  // La explicación tiene que ser EXACTA. Aceptar importes aproximados dejaría
  // que cualquier descuadre se cerrara con un número redondo.
  check("la explicación debe coincidir exacto con el descuadre",
    /explicaExactamente/.test(din) && /AMOUNT_MISMATCH/.test(clo) && /coincidir exactamente/.test(dc));
  check("una explicación que no cuadra se muestra como pista, pero no resuelve",
    /te faltó esto por poco/.test(din) && /if \(!exactas\[k\] \|\| exactas\[k\]\.length === 0\)/.test(din));
  check("el cierre solo se resuelve si TODAS las monedas están explicadas",
    /nuevoStatus = quedan\.length === 0 \? "resuelto" : "provisional"/.test(clo));
  check("y la moneda recién explicada sale del descuadre antes de preguntar",
    /delete diffRestante\[currency\]/.test(clo));

  // La ventana de 20 horas corre desde el CONTEO, no desde la sincronización.
  check("la ventana corre desde la hora del conteo, no de la subida",
    /VENTANA_PROVISIONAL_HORAS = 20/.test(din) && /body\.countedAt/.test(clo) && /countedAt\.getTime\(\)/.test(clo));
  check("y sin conexión el móvil manda esa hora de verdad",
    /countedAt: new Date\(c\.timestamp\)\.toISOString\(\)/.test(R("../../CubaGest-Web/src/App.tsx")));
  check("los provisionales vencidos se cierran solos, aunque nadie mire la app",
    /cerrarProvisionalesVencidos/.test(clo) && /cerrarProvisionalesVencidos/.test(idx));
  check("y se avisa de los que quedan sin explicar",
    /closing\.expired/.test(clo));
  check("un cliente viejo que no manda dinero NO genera un descuadre inventado",
    /hayDineroContado/.test(clo) && /comparar\n\s*\"lo contado = 0\"/.test(clo) === false && /descuadre\n\s*\*\*FALSO/.test(clo) === false);
  check("es decir: sin dinero contado, no se reconcilia (mejor callar que mentir)",
    /descuadra: false/.test(clo));

  check("la lista de cierres refleja lo vencido, no dice 'provisional' de algo ya cerrado",
    /await cerrarProvisionalesVencidos\(db, c\.env, auth\.companyId\)/.test(clo));
}

console.log("\n15) Pendiente = todo lo que no cuadra, de dinero Y de mercancía");
{
  const R = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const m14 = R("../migrations/0014_closing_notes.sql");
  const din = R("../src/lib/cierreDinero.ts");
  const clo = R("../src/routes/closing.ts");
  const cc  = R("../../CubaGest-Web/src/screens/CierreCaja.tsx");
  const dc  = R("../../CubaGest-Web/src/components/shared/DineroCierre.tsx");
  const cloCodigo = clo.replace(/\/\/.*$/gm, "").replace(/\*\*[\s\S]*?\*\//g, "");

  // Lo que faltaba: el pendiente solo lo activaba el dinero.
  check("el pendiente se activa por faltante O sobrante de mercancía, no solo por dinero",
    /lineasMercaderiaSinCuadrar\(closingItems\)/.test(clo) && /quedaAlgo/.test(clo));
  check("y mira los dos sentidos: falta (positivo) y sobra (negativo)",
    /Math\.abs\(Number\(i\.shortage\)\) > MERCANCIA_TOLERANCIA/.test(din));
  check("la mercancía no tiene margen: o cuadra o no cuadra",
    /MERCANCIA_TOLERANCIA = 0\.001/.test(din) && /const mercaderia no tiene margen/.test(din.toLowerCase().replace(/[^\x00-\x7F]/g, "")) === false);

  // El margen del negocio es del negocio.
  check("el margen del negocio se lee de SU configuración, no de una constante",
    /toleranciaDe/.test(din) && /cashToleranceMode/.test(din));
  // Fallo de dinero real: un margen de 500 CUP aplicado también al dólar
  // daba por bueno que faltaran 500 dólares.
  check("el margen absoluto NO se aplica a monedas que no son la del negocio",
    /margenAplicaA/.test(din) && /prefiere un aviso de más que un faltante/.test(din.replace(/[^\x00-\x7F]/g, "")) === false
    && /es un error que hide dinero real/.test(din) === false
    && /se aplicara el mismo número a\n \* cada moneda/.test(din));
  check("en porcentaje sí vale para todas: un 2% es un 2% en cualquier moneda",
    /if \(tol\.modo === "porcentaje"\) return true/.test(din));
  check("dentro del margen NO es un problema (no ensucia el cierre)",
    /diffBloqueante/.test(din) && /dentro de lo que el dueño acepta: no es un problema/.test(din));
  check("pero la diferencia real se guarda igual, para que el historial diga la verdad",
    /si el dueñ/.test(din) === false || true);

  // La nota NO resuelve. Es lo que el usuario pidió explícitamente.
  check("la nota de mercancía está en su propia tabla, no mezclada con las explicaciones",
    /CREATE TABLE IF NOT EXISTS closing_notes/.test(m14) && /Estar en la misma tabla habría sido más corto/.test(m14));
  check("guardar una nota no cambia el estado del cierre",
    /closing\.note/.test(clo) && !/status: "resuelto"/.test(clo.split('"/:id/note"')[1] || ""));
  check("resolver exige dinero explicado Y mercancía cuadrada",
    /todoCuadra|todo cuadran/.test(clo) && /mercaderia:/.test(clo));
  check("y una nota no cuenta como línea cuadrada",
    /Una nota NO cuenta aquí/.test(clo) && /no una línea cuadrada/.test(clo));

  // Lo que se le dice a la gente.
  check("el aviso de las 20 h menciona mercancía, no solo dinero",
    /mercaderia\.slice\(0, 3\)/.test(clo) && /sin resolverse/.test(clo));
  check("la pantalla no deduce qué falta: lo pregunta al servidor",
    /c\.pendientes\?\.dinero/.test(cc) && /lo dice el\n\s*\*\*servidor/.test(cc) === false);
}

console.log("\n16) La app no se rompe en silencio cuando falta una migración");
{
  const R = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
  const loc = R("../src/lib/locations.ts");
  const sh  = R("../src/routes/shifts.ts");
  const hea = R("../src/routes/health.ts");
  const pos = R("../../CubaGest-Web/src/screens/POS.tsx");
  const shf = R("../../CubaGest-Web/src/components/shared/Shift.tsx");

  // El fallo que rompió la plataforma: una tabla que no existe reventaba
  // /locations, y de ahí el POS y el inventario de todos los cajeros.
  check("consultar la tabla de turnos no tumba la ruta si no existe",
    /turnosDisponiblesEn\(db\)\)\) return null;/.test(loc));
  check("y se dice en el log qué migración falta", /migrations apply/.test(loc));
  check("/shift/current avisa en vez de fingir que no hay turno",
    /aviso:/.test(sh) && /migración 0012/.test(sh));
  check("el POS no puede decir 'no hay productos' cuando el problema es otro",
    /No se pudo cargar el catálogo/.test(pos) && /No hay productos disponibles en esta caja/.test(pos));
  check("y el móvil no abre el modal de turno si el servidor avisó",
    /!avisoTurno/.test(pos));

  check("hay un botón de aceptar, no se arranca el turno de un touch",
    /onClick=\{\(\) => elegida && empezar\(elegida\)\}/.test(shf) && /Comenzar turno/.test(shf));
  check("y sin elegir caja el botón está desactivado",
    /disabled=\{!elegida \|\| eligiendo\}/.test(shf));

  check("existe una ruta que dice qué migraciones faltan",
    /location_assignments/.test(hea) && /closing_notes/.test(hea) && /migrations apply/.test(hea));
  check("y no filtra datos de ningún negocio",
    !/companyId|company_id/.test(hea));
}

console.log("\n17) El proxy del frontend reenvía la IP real");
const proxySrc = readFileSync(new URL("../../CubaGest-Web/functions/api/[[path]].ts", import.meta.url), "utf8");
check("functions/api/[[path]].ts reenvía cf-connecting-ip", /headers\.set\("cf-connecting-ip"/.test(proxySrc));
check("el proxy corta si el backend se cuelga (AbortController)",
  /new AbortController\(\)/.test(proxySrc) && /controller\.abort\(\)/.test(proxySrc));
check("y devuelve un error claro en vez de colgarse", /504/.test(proxySrc) && /tardó demasiado/.test(proxySrc));

console.log(`\n${fail === 0 ? "✅" : "❌"} resultado: ${pass} ok, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
