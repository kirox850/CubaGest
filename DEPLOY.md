# Deploy CubaGest Backend v2.0 (Cloudflare Workers + D1 + Hono + Drizzle)

## 1. Instalar dependencias

```bash
npm install
```

## 2. Crear base de datos D1

```bash
npx wrangler d1 create cubagest-db
```

Copiar el `database_id` que te devuelve y pegarlo en `wrangler.toml` reemplazando `REEMPLAZAR_TRAS_CREAR_EN_DASHBOARD`.

## 3. Configurar secrets

```bash
npx wrangler secret put JWT_SECRET
# Escribe un string largo y aleatorio (minimo 32 caracteres)

npx wrangler secret put QVAPAY_APP_ID      # opcional
npx wrangler secret put QVAPAY_APP_SECRET  # opcional
npx wrangler secret put QVAPAY_CALLBACK_URL  # opcional
npx wrangler secret put APP_URL              # opcional
```

## 4. Ejecutar migracion inicial

Local:
```bash
npm run db:migrate:local
```

Produccion:
```bash
npm run db:migrate
```

## 5. Desarrollo local

```bash
npm run dev
```

El servidor estara disponible en `http://localhost:8787`.

## 6. Deploy a produccion

```bash
npm run deploy
```

## 7. Endpoints principales

- `POST /auth/register` - Crear empresa + admin
- `POST /auth/login` - Login
- `POST /auth/refresh` - Renovar token
- `GET /auth/me` - Usuario actual
- `GET /users` - Listar usuarios (admin)
- `POST /users` - Crear usuario (admin)
- `GET /products` - Listar productos
- `POST /products` - Crear producto
- `POST /products/:id/adjust-stock` - Ajustar stock
- `GET /sales` - Listar ventas
- `POST /sales` - Crear venta
- `POST /sales/:id/void` - Anular venta
- `POST /sales/sync` - Sincronizar ventas offline
- `GET /invoices/:id` - Detalle de factura
- `GET /invoices/:id/pdf-data` - Datos para PDF
- `GET /accounting/summary` - Resumen contable
- `GET /accounting/expenses` - Listar gastos
- `POST /accounting/expenses` - Crear gasto
- `GET /dashboard/summary` - Resumen dashboard
- `GET /closing/readings` - Lecturas de inventario
- `POST /closing/confirm` - Confirmar cierre de caja
- `GET /subscription/status` - Estado de suscripcion
- `GET /subscription` - Plan actual y uso
- `POST /subscription/whatsapp` - URL de WhatsApp

## 8. Notas de migracion desde Express

- Las transacciones de base de datos en D1 son automaticas por statement.
- No hay `SELECT ... FOR UPDATE` en SQLite/D1. El bloqueo de fila no esta disponible.
- Los JSON se guardan como TEXT con `$defaultFn(() => [])`.
- El rate limiting es en memoria (se reinicia con cada instancia de Worker).
- No hay cron jobs nativos en Workers. Usar Cloudflare Cron Triggers o un servicio externo.
