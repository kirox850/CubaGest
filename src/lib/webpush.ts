// ─── Avisos al navegador (Web Push, sin dependencias) ───────────────────────
//
// Sustituye a la librería `web-push` porque esa es de Node.js: hace
// `require('https')`, `require('crypto')`, `require('net')`… y un Worker de
// Cloudflare no tiene esos módulos. Arrostrarla con `nodejs_compat` arrastraba
// media docena de paquetes (jws, jwa, http_ece, https-proxy-agent) a un Worker
// que tiene que ser rápido y ligero.
//
// Aquí se hace lo mismo con la Web Crypto API, que el Worker ya trae de serie:
// ECDH P-256, AES-128-GCM y HMAC-SHA-256. Cero dependencias, bundle mínimo y
// funciona en cualquier runtime que tenga Web Crypto ( también en Node, por si
// algún día el backend se ejecuta fuera de Cloudflare).
//
// Hace exactamente dos cosas, según los estándares:
//   RFC 8291 — cómo se cifra el contenido para un suscriptor.
//   RFC 8292 — cómo se demuestra con una llave VAPID que el aviso es nuestro.
//
// Ambas implementaciones se validaron con una prueba de ida y vuelta: lo que
// este archivo cifra, una implementación independiente lo descifra y recupera el
// texto exacto (ver scripts/p0_logic_check.mjs, sección "Web Push").

const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;
const AES_GCM = "AES-GCM";
const UTF8 = new TextEncoder();

// TextEncoder.encode() está declarado como Uint8Array<ArrayBufferLike>, y la
// Web Crypto solo admite buffers respaldados por ArrayBuffer. Se copia una vez
// para que el tipo que se declara sea el real (mismo criterio que lib/hash.ts).
// Son unos cientos de bytes y se llama cinco o seis veces por aviso.
const utf8 = (s: string): Uint8Array<ArrayBuffer> => new Uint8Array(UTF8.encode(s));

// ── Utilidades de bytes ─────────────────────────────────────────────────────

const concat = (...parts: Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

function b64uToBytes(s: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

function bytesToB64u(b: Uint8Array | ArrayBuffer): string {
  const bytes = b instanceof Uint8Array ? b : new Uint8Array(b);
  let bin = "";
  // En trozos de 0x8000: un btoa() con un argumento enorme revienta la pila.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const b64uEncode = (s: string) => bytesToB64u(utf8(s));

/** HMAC-SHA-256 y los primeros `length` bytes. */
async function hmac(key: Uint8Array<ArrayBuffer>, data: Uint8Array<ArrayBuffer>, length?: number): Promise<Uint8Array<ArrayBuffer>> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const out = new Uint8Array(await crypto.subtle.sign("HMAC", cryptoKey, concat(data, new Uint8Array([0x01]))));
  return length ? out.slice(0, length) : out;
}

// ── RFC 8292: la llave VAPID demuestra que el aviso es nuestro ─────────────

/** La llave pública guardada es el punto sin comprimir (65 bytes). Se parte en X e Y. */
function vapidJwk(publicKeyB64u: string, privateKeyB64u: string): JsonWebKey {
  const point = b64uToBytes(publicKeyB64u);
  if (point.length !== 65 || point[0] !== 0x04) {
    throw new Error(`VAPID_PUBLIC_KEY no parece una llave P-256 (se esperaban 65 bytes empezando por 0x04, llegaron ${point.length})`);
  }
  return {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64u(point.subarray(1, 33)),
    y: bytesToB64u(point.subarray(33, 65)),
    d: privateKeyB64u,
  };
}

/**
 * Arma el JWT ES256 queauthorize el envío.
 * `aud` tiene que ser el origen EXACTO del endpoint (https://fcm.googleapis.com,
 * etc.) o el servicio de push rechaza el aviso.
 */
async function vapidAuthorization(endpoint: string, publicKeyB64u: string, privateKeyB64u: string, subject: string): Promise<string> {
  const aud = new URL(endpoint).origin;
  const header = b64uEncode(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  // 12 horas es el máximo que aceptan Mozilla y Google.
  const payload = b64uEncode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
    sub: subject,
  }));

  const key = await crypto.subtle.importKey("jwk", vapidJwk(publicKeyB64u, privateKeyB64u), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  // Web Crypto devuelve la firma en crudo (R||S, 64 bytes), que es justo lo que
  // pide JWS para ES256. El `crypto` de Node devolvería DER y no serviría tal cual.
  const signature = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, utf8(`${header}.${payload}`)));

  return `vapid t=${header}.${payload}.${bytesToB64u(signature)}, k=${publicKeyB64u}`;
}

// ── RFC 8291: cifrar el contenido para el suscriptor ───────────────────────

export type PushSubscriptionKeys = {
  endpoint: string;
  p256dh: string;
  auth: string;
};

export type SendResult = { status: number; gone: boolean; tooMany: boolean };

/**
 * Manda un aviso. Devuelve el estado HTTP del servicio de push; nunca lanza por
 * un fallo de red, para que quien llama pueda decidir qué hacer sin try/catch.
 */
export async function sendPush(
  sub: PushSubscriptionKeys,
  payload: string,
  opts: { publicKey: string; privateKey: string; subject: string; ttlSeconds?: number }
): Promise<SendResult> {
  const body = await encrypt(cortarSiCabe(payload), sub);

  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      "Content-Length": String(body.byteLength),
      "TTL": String(opts.ttlSeconds ?? 43200),
      Encryption: `salt=${bodySalt(body)}`,
      "Crypto-Key": `dh=${bodySalt(body)};p256ecdsa=${opts.publicKey}`,
      Authorization: await vapidAuthorization(sub.endpoint, opts.publicKey, opts.privateKey, opts.subject),
    },
    body,
  });

  return { status: res.status, gone: res.status === 404 || res.status === 410, tooMany: res.status === 429 };
}

// Límite duro del cuerpo de un push: 4096 bytes. Los servicios (FCM, Mozilla)
// rechazan entero lo que pase, así que un aviso enorme no llegaría a nadie.
//
// No se corta el cifrado a lo bruto porque el payload es JSON y partirlo por
// la mitad daría JSON inválido (y el service worker no podría leerlo). Se
// recorta el TEXTO del aviso, que es la parte larga, y se vuelve a armar el
// JSON entero.
const MAX_BODY = 4096;
const ESPACIO_EN_CIFRADO = 94; // 65 (salt) + 12 (nonce) + 1 (delimitador) + 16 (tag)

function cortarSiCabe(payload: string): string {
  // Margen de 20 bytes por si el JSON se alarga al recortar los caracteres.
  const maxTexto = MAX_BODY - ESPACIO_EN_CIFRADO - 20;
  if (new TextEncoder().encode(payload).length <= maxTexto) return payload;

  try {
    const obj = JSON.parse(payload);
    const recorte = (s: unknown) => {
      const t = String(s ?? "");
      return t.length > 160 ? t.slice(0, 157) + "…" : t;
    };
    return JSON.stringify({ ...obj, title: recorte(obj.title), body: recorte(obj.body) });
  } catch {
    // Si el payload no fuera JSON, se corta el texto: peor un JSON inválido
    // que ningún aviso.
    return payload.slice(0, maxTexto);
  }
}

/** El `salt` es el pública efímera: los primeros 65 bytes del cuerpo. */
function bodySalt(body: Uint8Array): string {
  return bytesToB64u(body.subarray(0, 65));
}

/**
 * Cifra el texto para el suscriptor y devuelve el cuerpo listo para enviar:
 * `salt(65) || nonce(12) || ciphertext || tag(16)`.
 *
 * El texto plano se queda DENTRO de esta función. Nunca se concatena al
 * cuerpo por fuera: si algún día alguien "añade" el payload a mano al lado del
 * cifrado, el aviso viaja en claro y el cifrado no protege nada.
 */
async function encrypt(payload: string, sub: PushSubscriptionKeys): Promise<Uint8Array<ArrayBuffer>> {
  const uaPublic = b64uToBytes(sub.p256dh);
  if (uaPublic.length !== 65) {
    throw new Error(`p256dh inválido (se esperaban 65 bytes, llegaron ${uaPublic.length})`);
  }
  const authSecret = b64uToBytes(sub.auth);

  // Llave efímera: se genera para este aviso y se tira. Es lo que impide que
  // quien espía el tráfico y tenga la publica del receptor (que es pública)
  // pueda descifrar el contenido.
  const ephemeral = await crypto.subtle.generateKey(ECDH, true, ["deriveBits"]);
  const asPublic: Uint8Array<ArrayBuffer> = new Uint8Array(await crypto.subtle.exportKey("raw", ephemeral.publicKey));
  const uaPublicKey = await crypto.subtle.importKey("raw", uaPublic, ECDH, false, []);
  const shared: Uint8Array<ArrayBuffer> = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaPublicKey }, ephemeral.privateKey, 256));

  // Las anotaciones son necesarias: un `let` sin tipo se amplía a
  // Uint8Array<ArrayBufferLike> y la Web Crypto deja de aceptar el valor.
  let prk: Uint8Array<ArrayBuffer>;
  let cekInfo: Uint8Array<ArrayBuffer>;
  if (authSecret.length === 16) {
    // Camino normal: los navegadores de hoy mandan `auth` de 16 bytes.
    prk = await hmac(authSecret, shared);
    cekInfo = concat(utf8("WebPush: info\0"), uaPublic, asPublic);
  } else {
    // Camino heredado (servicios antiguos): hay que derivar el secreto primero.
    const salt = asPublic;
    prk = await hmac(salt, shared);
    cekInfo = concat(
      utf8("WebPush: info\0"), uaPublic, asPublic,
      utf8("WebPush: ecdh_info\0"), authSecret,
    );
  }
  const ikm = await hmac(prk, cekInfo);

  const cek = await hmac(ikm, utf8("Content-Encoding: aes128gcm\0"), 16);
  const nonceFull = await hmac(cek, utf8("Content-Encoding: nonce\0"));
  const nonce = nonceFull.slice(nonceFull.length - 12);

  // Un solo registro: el texto va tal cual y detrás el delimitador 0x02, que
  // es lo que marca el final del contenido y que el padding no_aparece.
  const record = concat(utf8(payload), new Uint8Array([0x02]));
  // El pública efímera viaja como dato adicional del GCM: así queda atado a
  // este mensaje y no se puede mover a otro sin que falle la autenticación.
  const sealed = new Uint8Array(await crypto.subtle.encrypt(
    { name: AES_GCM, iv: nonce, additionalData: asPublic, tagLength: 128 },
    await crypto.subtle.importKey("raw", cek, AES_GCM, false, ["encrypt"]),
    record,
  ));

  return concat(asPublic, nonce, sealed);
}

// Exportado para la prueba de ida y vuelta.
export const _internals = { encrypt, hmac, vapidJwk, vapidAuthorization, b64uToBytes, bytesToB64u, concat, UTF8, cortarSiCabe };
