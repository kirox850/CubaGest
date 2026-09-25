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

import { signToken, verifyToken, ACCESS_TOKEN_TTL_SECONDS, REFRESH_TOKEN_TTL_DAYS, PLATFORM_TOKEN_TTL_SECONDS, SUPPORT_TOKEN_TTL_SECONDS } from "../src/lib/jwt.ts";
import { isDiscountAvailable, computeDiscountAmount } from "../src/lib/discountRules.ts";

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

console.log(`\n${fail === 0 ? "✅" : "❌"} resultado: ${pass} ok, ${fail} fallos`);
process.exit(fail === 0 ? 0 : 1);
