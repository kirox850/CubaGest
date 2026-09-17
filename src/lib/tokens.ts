// Tokens aleatorios de un solo uso (para "establecer contraseña" / "olvidé
// mi contraseña"). Se guarda el HASH en la base de datos, nunca el token
// en sí — igual que una contraseña.

export function generateRawToken(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function hashToken(raw: string): Promise<string> {
  const data = new TextEncoder().encode(raw);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
