// Hashing de contraseñas con PBKDF2 via Web Crypto API
// Compatible con Cloudflare Workers (no usa bcryptjs)

const ITERATIONS = 100_000;
const KEY_LENGTH = 32;
const HASH_ALGO = "SHA-256";

async function deriveKey(password: string, salt: Uint8Array): Promise<ArrayBuffer> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
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

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function fromHex(hex: string): Uint8Array {
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
