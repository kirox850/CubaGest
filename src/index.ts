import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import auth from "./routes/auth";
import users from "./routes/users";
import products from "./routes/products";
import sync from "./routes/sync";      // FIX: sync antes que sales
import sales from "./routes/sales";    // FIX: sales después de sync
import invoices from "./routes/invoices";
import accounting from "./routes/accounting";
import subscriptions, { renewQvapaySubscriptions } from "./routes/subscriptions";
import dashboard from "./routes/dashboard";
import closing from "./routes/closing";

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

app.onError((err, c) => {
  console.error(err);
  return c.json({ ok: false, error: "Error interno del servidor" }, 500);
});

export default {
  fetch: app.fetch,

  // Cron trigger (ver [triggers] en wrangler.toml): cobra automáticamente
  // las suscripciones QvaPay cuyo próximo pago ya venció.
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(renewQvapaySubscriptions(env));
  },
};
