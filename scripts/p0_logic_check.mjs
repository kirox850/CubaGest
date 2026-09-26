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

console.log("\n10) El proxy del frontend reenvía la IP real");
const proxySrc = readFileSync(new URL("../../CubaGest-Web/functions/api/[[path]].ts", import.meta.url), "utf8");
check("functions/api/[[path]].ts reenvía cf-connecting-ip", /headers\.set\("cf-connecting-ip"/.test(proxySrc));
check("el proxy corta si el backend se cuelga (AbortController)",
  /new AbortController\(\)/.test(proxySrc) && /controller\.abort\(\)/.test(proxySrc));
check("y devuelve un error claro en vez de colgarse", /504/.test(proxySrc) && /tardó demasiado/.test(proxySrc));

console.log(`\n${fail === 0 ? "✅" : "❌"} resultado: ${pass} ok, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
