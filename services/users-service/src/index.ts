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
const SERVICE_NAME = 'users-service';

// ---------- Database pool ----------
const pool = new Pool({
  host: process.env.PGHOST || 'localhost',
  port: parseInt(process.env.PGPORT || '5432', 10),
  user: process.env.PGUSER || 'postgres',
  password: process.env.PGPASSWORD || '',
  database: process.env.PGDATABASE || 'users',
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

// ---------- Helper: timed query ----------
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

// ---------- Database initialization with retry ----------
async function initDb(maxAttempts = 15): Promise<void> {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS users (
          id SERIAL PRIMARY KEY,
          name TEXT NOT NULL,
          email TEXT NOT NULL UNIQUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      const { rows } = await pool.query('SELECT COUNT(*)::int AS count FROM users');
      if (rows[0].count === 0) {
        await pool.query(`
          INSERT INTO users (name, email) VALUES
            ('Ada Lovelace', 'ada@example.com'),
            ('Alan Turing', 'alan@example.com')
        `);
        logger.info('seeded initial users');
      }
      logger.info('database initialized');
      return;
    } catch (err) {
      logger.warn({ err: (err as Error).message, attempt }, 'database not ready, retrying in 3s');
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error(`database initialization failed after ${maxAttempts} attempts`);
}

// ---------- Routes ----------

// Liveness: is the process alive? Don't touch the DB — we don't want a DB hiccup to kill pods.
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: SERVICE_NAME });
});

// Readiness: can this pod serve traffic RIGHT NOW? Check the DB.
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

app.get('/users', async (_req: Request, res: Response) => {
  try {
    const rows = await timedQuery<any>(
      'list_users',
      'SELECT id::text, name, email, created_at AS "createdAt" FROM users ORDER BY id',
    );
    res.json({ users: rows });
  } catch (err) {
    logger.error({ err }, 'list users failed');
    res.status(500).json({ error: 'internal error' });
  }
});

app.get('/users/:id', async (req: Request, res: Response) => {
  try {
    const rows = await timedQuery<any>(
      'get_user',
      'SELECT id::text, name, email, created_at AS "createdAt" FROM users WHERE id = $1',
      [req.params.id],
    );
    if (rows.length === 0) {
      return res.status(404).json({ error: 'user not found' });
    }
    return res.json(rows[0]);
  } catch (err) {
    logger.error({ err }, 'get user failed');
    return res.status(500).json({ error: 'internal error' });
  }
});

app.post('/users', async (req: Request, res: Response) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  try {
    const rows = await timedQuery<any>(
      'create_user',
      `INSERT INTO users (name, email)
       VALUES ($1, $2)
       RETURNING id::text, name, email, created_at AS "createdAt"`,
      [name, email],
    );
    return res.status(201).json(rows[0]);
  } catch (err: any) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'email already exists' });
    }
    logger.error({ err }, 'create user failed');
    return res.status(500).json({ error: 'internal error' });
  }
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: SERVICE_NAME,
    version: '0.2.0',
    endpoints: ['/healthz', '/readyz', '/metrics', '/users', '/users/:id'],
  });
});

// ---------- Start ----------
async function main() {
  await initDb();
  const server = app.listen(PORT, () => {
    logger.info({ port: PORT, service: SERVICE_NAME }, 'service started');
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
