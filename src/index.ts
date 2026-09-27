import { Hono } from "hono";
import { drizzle } from "drizzle-orm/d1";
import * as schema from "./db/schema";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import auth from "./routes/auth";
import users from "./routes/users";
import products from "./routes/products";
import sync from "./routes/sync";      // FIX: sync antes que sales
import sales from "./routes/sales";    // FIX: sales después de sync
import invoices from "./routes/invoices";
import accounting from "./routes/accounting";
import subscriptions, { renewQvapaySubscriptions, sweepPaymentAuthorizations } from "./routes/subscriptions";
import dashboard from "./routes/dashboard";
import closing from "./routes/closing";
import locations from "./routes/locations";
import transfers from "./routes/transfers";
import audit from "./routes/audit";
import discounts from "./routes/discounts";
import settings from "./routes/settings";
import platform from "./routes/platform";
import referrals from "./routes/referrals";
import push from "./routes/push";
import shifts from "./routes/shifts";
import cashMovements from "./routes/cashMovements";
import health from "./routes/health";
import { cerrarProvisionalesVencidos } from "./routes/closing";

const app = new Hono<{ Bindings: Env }>();

app.use("*", logger());
app.use(
  "*",
  cors({
    origin: ["https://cubagest.dpdns.org", "http://localhost:5173"],
    allowMethods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowHeaders: ["Content-Type", "Authorization"],
  })
);

app.get("/health", (c) => c.json({ ok: true, version: "2.0.0" }));

app.route("/auth", auth);
app.route("/users", users);
app.route("/products", products);
app.route("/sales/sync", sync);   // FIX: montar /sales/sync ANTES que /sales
app.route("/sales", sales);
app.route("/invoices", invoices);
app.route("/accounting", accounting);
app.route("/subscription", subscriptions);
app.route("/dashboard", dashboard);
app.route("/closing", closing);
app.route("/locations", locations);
app.route("/transfers", transfers);
app.route("/audit", audit);
app.route("/discounts", discounts);
app.route("/settings", settings);
app.route("/platform", platform);
app.route("/referrals", referrals);
app.route("/push", push);
app.route("/shift", shifts);
app.route("/cash-movements", cashMovements);
app.route("/health", health);

app.onError((err, c) => {
  console.error(err);
  return c.json({ ok: false, error: "Error interno del servidor" }, 500);
});

export default {
  fetch: app.fetch,

  // Cron trigger (ver [triggers] en wrangler.toml): cobra automáticamente
  // las suscripciones QvaPay cuyo próximo pago ya venció, y después barre las
  // autorizaciones de pago viejas o que se quedaron a medias.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(renewQvapaySubscriptions(env));
    // Va aparte (y en paralelo) para que un fallo en el barrido —o en las
    // renovaciones— no se lleve por delante al otro. Las renovaciones pueden
    // tardar hasta ~100 s por el ritmo de QvaPay, así que encadenarlas
    // detrás añadiría esa espera a un trabajo que debería ser instantáneo.
    ctx.waitUntil(sweepPaymentAuthorizations(env));
    // Los cierres provisionales que pasaron su ventana sin explicación se
    // cierran solos, aunque nadie abra la aplicación: el aviso tiene que salir
    // a las 20 horas, no cuando el dueño se acuerde de mirar.
    ctx.waitUntil((async () => {
      const db = drizzle(env.DB, { schema });
      const n = await cerrarProvisionalesVencidos(db, env);
      if (n) console.log(`cerrados ${n} cierre(s) provisional(es) vencido(s)`);
    })());
  },
};
