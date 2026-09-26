// Hashing de contraseñas con PBKDF2 via Web Crypto API
// Compatible con Cloudflare Workers (no usa bcryptjs)

const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const HASH_ALGO = "SHA-256";

// Texto → bytes en un ArrayBuffer propio.
//
// Desde TypeScript 5.7, `Uint8Array` es genérico sobre el tipo de su buffer
// (`Uint8Array<ArrayBuffer>` vs `<ArrayBufferLike>`) y `crypto.subtle` solo
// acepta el primero. `TextEncoder.encode()` devuelve el segundo, así que el
// compilador lo rechazaba. En vez de castear a `any` en cada llamada — que
// escondería errores de verdad — se copia una vez aquí, y el tipo que se
// declara es el que realmente tiene el buffer. El costo es una copia de unos
// pocos bytes por llamada, y solo se compara contraseñas.
function utf8(str: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(str));
}

async function deriveKey(password: string, salt: Uint8Array<ArrayBuffer>): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    utf8(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  return crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations: ITERATIONS, hash: HASH_ALGO },
    keyMaterial,
    KEY_LENGTH * 8
  );
}

// Acepta ArrayBuffer o TypedArray: ambos se leen igual con `new Uint8Array(...)`,
// y los dos aparecen en este archivo (crypto.subtle devuelve ArrayBuffer,
// crypto.getRandomValues devuelve TypedArray). Declarar solo uno de los dos
// obligaba a castear en el punto de llamada.
function toHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  const matches = hex.match(/.{2}/g);
  if (!matches) throw new Error("Hex inválido");
  return new Uint8Array(matches.map((h) => parseInt(h, 16)));
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await deriveKey(password, salt);
  return `pbkdf2:${toHex(salt)}:${toHex(hash)}`;
}

export async function comparePassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split(":");
  if (parts.length !== 3 || parts[0] !== "pbkdf2") return false;
  const salt = fromHex(parts[1]);
  const hash = await deriveKey(password, salt);
  return toHex(hash) === parts[2];
}
