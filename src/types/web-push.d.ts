// Tipos de `web-push`, la librería que manda los avisos al navegador.
//
// Se declara aquí a mano, y no con los tipos del paquete, por dos razones:
//  1. El paquete todavía no está instalado (se instala con `npm i web-push`), y
//     sin esta declaración el typecheck falla por una dependencia que solo hace
//     falta para UNA funcionalidad opcional.
//  2. De este archivo solo se usan dos funciones. Declararlas aquí fija la
//     superficie que el proyecto depende, para que una actualización del paquete
//     no rompa la compilación a medio camino.
//
// Cuando el paquete esté instalado, sus tipos reales pasan a mandar (una
// declaración local de un módulo solo se usa si el paquete no trae la suya).

declare module "web-push" {
  interface PushSubscription {
    endpoint: string;
    expirationTime?: number | null;
    keys: {
      p256dh: string;
      auth: string;
    };
  }

  interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  interface WebPushError extends Error {
    statusCode?: number;
    body?: string;
    headers?: Record<string, string>;
  }

  export function setVapidDetails(subject: string, publicKey: string, privateKey: string): void;

  export function sendNotification(
    subscription: PushSubscription,
    payload?: string | null,
    options?: {
      TTL?: number;
      urgency?: "very-low" | "low" | "normal" | "high";
      topic?: string;
    }
  ): Promise<SendResult>;

  const webPush: {
    setVapidDetails: typeof setVapidDetails;
    sendNotification: typeof sendNotification;
  };
  export default webPush;
}
