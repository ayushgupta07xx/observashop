import express, { Request, Response, NextFunction } from 'express';
import client from 'prom-client';
import pino from 'pino';
import pinoHttp from 'pino-http';
import { Pool } from 'pg';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: { level: (label) => ({ level: label }) },
});

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVICE_NAME = 'orders-service';

const USERS_SERVICE_URL = process.env.USERS_SERVICE_URL || 'http://users-service.observashop.svc.cluster.local';
const PRODUCTS_SERVICE_URL = process.env.PRODUCTS_SERVICE_URL || 'http://products-service.observashop.svc.cluster.local';

// ---------- Database pool ----------
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'orders',
  max: 10,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

pool.on('error', (err) => {
  logger.error({ err }, 'unexpected postgres pool error');
});

// ---------- Prometheus metrics ----------
const register = new client.Registry();
register.setDefaultLabels({ service: SERVICE_NAME });
client.collectDefaultMetrics({ register });

const httpRequestsTotal = new client.Counter({
  name: 'http_requests_total',
  help: 'Total number of HTTP requests',
  labelNames: ['method', 'route', 'status_code'],
  registers: [register],
});

const httpRequestDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'HTTP request duration in seconds',
  labelNames: ['method', 'route', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const dbQueryDuration = new client.Histogram({
  name: 'db_query_duration_seconds',
  help: 'Database query duration in seconds',
  labelNames: ['operation'],
  buckets: [0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1],
  registers: [register],
});

// Outbound HTTP call metrics — the new thing in this service
const httpClientRequestDuration = new client.Histogram({
  name: 'http_client_request_duration_seconds',
  help: 'Outbound HTTP client request duration in seconds',
  labelNames: ['target_service', 'operation', 'status_code'],
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
  registers: [register],
});

const httpClientRequestsTotal = new client.Counter({
  name: 'http_client_requests_total',
  help: 'Total outbound HTTP client requests',
  labelNames: ['target_service', 'operation', 'status_code'],
  registers: [register],
});

// ---------- Middleware ----------
app.use(express.json());
app.use(pinoHttp({ logger }));

app.use((req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const route = req.route?.path || req.path;
    const labels = {
      method: req.method,
      route,
      status_code: res.statusCode.toString(),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, durationSec);
  });
  next();
});

// ---------- Helpers ----------
async function timedQuery<T extends Record<string, any>>(
  operation: string,
  sql: string,
  params: any[] = [],
): Promise<T[]> {
  const start = process.hrtime.bigint();
  try {
    const result = await pool.query(sql, params);
    return result.rows as T[];
  } finally {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    dbQueryDuration.observe({ operation }, durationSec);
  }
}

// Instrumented fetch wrapper — every outbound call records latency and outcome
async function timedFetch(
  targetService: string,
  operation: string,
  url: string,
  init?: RequestInit,
): Promise<globalThis.Response> {
  const start = process.hrtime.bigint();
  let statusCode = '0';
  try {
    const response = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(5000), // 5s hard timeout
    });
    statusCode = response.status.toString();
    return response;
  } catch (err) {
    statusCode = 'error';
    throw err;
  } finally {
    const durationSec = Number(process.hrtime.bigint() - start) / 1e9;
    const labels = { target_service: targetService, operation, status_code: statusCode };
    httpClientRequestDuration.observe(labels, durationSec);
    httpClientRequestsTotal.inc(labels);
  }
}

async function userExists(userId: string): Promise<boolean> {
  const r = await timedFetch('users-service', 'get_user', `${USERS_SERVICE_URL}/users/${userId}`);
  return r.status === 200;
}

async function productExists(productId: string): Promise<{ ok: boolean; price?: number }> {
  const r = await timedFetch('products-service', 'get_product', `${PRODUCTS_SERVICE_URL}/products/${productId}`);
  if (r.status !== 200) return { ok: false };
  const body = (await r.json()) as { priceCents: number };
  return { ok: true, price: body.priceCents };
}

// ---------- DB init ----------
async function initDb(maxAttempts = 15): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS orders (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          product_id TEXT NOT NULL,
          quantity INTEGER NOT NULL CHECK (quantity > 0),
          total_cents INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      logger.info('database initialized');
      return;
    } catch (err) {
      logger.warn({ err: (err as Error).message, attempt }, 'database not ready, retrying in 3s');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`database initialization failed after ${maxAttempts} attempts`);
}

// ---------- Routes: health and metrics ----------
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: SERVICE_NAME });
});

app.get('/readyz', async (_req: Request, res: Response) => {
  try {
    await pool.query('SELECT 1');
    res.status(200).json({ status: 'ready', service: SERVICE_NAME });
  } catch (err) {
    res.status(503).json({ status: 'not ready', service: SERVICE_NAME, error: (err as Error).message });
  }
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// ---------- Routes: business logic ----------
app.get('/orders', async (_req: Request, res: Response) => {
  try {
    const rows = await timedQuery<any>(
      'list_orders',
      `SELECT id::text, user_id AS "userId", product_id AS "productId",
              quantity, total_cents AS "totalCents", status,
              created_at AS "createdAt"
       FROM orders ORDER BY id DESC LIMIT 100`,
    );
    res.json({ orders: rows });
  } catch (err) {
    logger.error({ err }, 'list orders failed');
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/orders/:id', async (req: Request, res: Response) => {
  try {
    const rows = await timedQuery<any>(
      'get_order',
      `SELECT id::text, user_id AS "userId", product_id AS "productId",
              quantity, total_cents AS "totalCents", status,
              created_at AS "createdAt"
       FROM orders WHERE id = $1`,
      [req.params.id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'order not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'get order failed');
    return res.status(500).json({ error: 'internal error' });
  }
});

// The interesting endpoint: validates user + product via inter-service calls,
// then persists the order. Demonstrates HTTP client instrumentation,
// timeouts, and graceful degradation on upstream failure.
app.post('/orders', async (req: Request, res: Response) => {
  const { userId, productId, quantity } = req.body;
  if (!userId || !productId || typeof quantity !== 'number' || quantity <= 0) {
    return res.status(400).json({ error: 'userId, productId, and positive quantity are required' });
  }

  // Validate user exists (call users-service)
  let userOk = false;
  try {
    userOk = await userExists(userId);
  } catch (err) {
    logger.error({ err, userId }, 'users-service unreachable');
    return res.status(502).json({ error: 'users-service unreachable' });
  }
  if (!userOk) {
    return res.status(404).json({ error: 'user not found' });
  }

  // Validate product and get price (call products-service)
  let productResult: { ok: boolean; price?: number };
  try {
    productResult = await productExists(productId);
  } catch (err) {
    logger.error({ err, productId }, 'products-service unreachable');
    return res.status(502).json({ error: 'products-service unreachable' });
  }
  if (!productResult.ok || typeof productResult.price !== 'number') {
    return res.status(404).json({ error: 'product not found' });
  }

  const totalCents = productResult.price * quantity;

  try {
    const rows = await timedQuery<any>(
      'create_order',
      `INSERT INTO orders (user_id, product_id, quantity, total_cents, status)
       VALUES ($1, $2, $3, $4, 'confirmed')
       RETURNING id::text, user_id AS "userId", product_id AS "productId",
                 quantity, total_cents AS "totalCents", status,
                 created_at AS "createdAt"`,
      [userId, productId, quantity, totalCents],
    );
    return res.status(201).json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'create order failed');
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: SERVICE_NAME,
    version: '0.1.0',
    endpoints: ['/healthz', '/readyz', '/metrics', '/orders', '/orders/:id'],
    upstreams: { USERS_SERVICE_URL, PRODUCTS_SERVICE_URL },
  });
});

// ---------- Start ----------
async function main() {
  await initDb();
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT, service: SERVICE_NAME, USERS_SERVICE_URL, PRODUCTS_SERVICE_URL }, 'service started');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'shutdown signal received');
    server.close(async () => {
      logger.info('http server closed');
      try {
        await pool.end();
        logger.info('db pool drained');
      } catch (err) {
        logger.error({ err }, 'error draining db pool');
      }
      process.exit(0);
    });
    setTimeout(() => {
      logger.error('forced shutdown after timeout');
      process.exit(1);
    }, 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'fatal startup error');
  process.exit(1);
});
// build trigger 1775815303
