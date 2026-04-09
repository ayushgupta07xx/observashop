import express, { Request, Response, NextFunction } from 'express';
import client from 'prom-client';
import pino from 'pino';
import pinoHttp from 'pino-http';

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  formatters: {
    level: (label) => ({ level: label }),
  },
});

const app = express();
const PORT = parseInt(process.env.PORT || '3000', 10);
const SERVICE_NAME = 'users-service';

// ---------- Prometheus metrics setup ----------
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

// ---------- Middleware ----------
app.use(express.json());
app.use(pinoHttp({ logger }));

// Track every request for metrics
app.use((req: Request, res: Response, next: NextFunction) => {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSec = durationNs / 1e9;
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

// ---------- In-memory "database" ----------
interface User {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

const users = new Map<string, User>();
users.set('1', {
  id: '1',
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  createdAt: new Date().toISOString(),
});
users.set('2', {
  id: '2',
  name: 'Alan Turing',
  email: 'alan@example.com',
  createdAt: new Date().toISOString(),
});

// ---------- Routes ----------

// Liveness probe — is the process alive?
app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: SERVICE_NAME });
});

// Readiness probe — is the process ready to serve traffic?
app.get('/readyz', (_req: Request, res: Response) => {
  // In a real service this would check DB connections, etc.
  res.status(200).json({ status: 'ready', service: SERVICE_NAME });
});

// Prometheus scrape endpoint
app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// List users
app.get('/users', (_req: Request, res: Response) => {
  res.json({ users: Array.from(users.values()) });
});

// Get one user
app.get('/users/:id', (req: Request, res: Response) => {
  const user = users.get(req.params.id as string);
  if (!user) {
    return res.status(404).json({ error: 'user not found' });
  }
  return res.json(user);
});

// Create user
app.post('/users', (req: Request, res: Response) => {
  const { name, email } = req.body;
  if (!name || !email) {
    return res.status(400).json({ error: 'name and email are required' });
  }
  const id = (users.size + 1).toString();
  const user: User = { id, name, email, createdAt: new Date().toISOString() };
  users.set(id, user);
  return res.status(201).json(user);
});

// Root
app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: SERVICE_NAME,
    version: '1.0.0',
    endpoints: ['/healthz', '/readyz', '/metrics', '/users', '/users/:id'],
  });
});

// ---------- Start ----------
const server = app.listen(PORT, () => {
  logger.info({ port: PORT, service: SERVICE_NAME }, 'service started');
});

// Graceful shutdown — SRE best practice
const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutdown signal received');
  server.close(() => {
    logger.info('http server closed, exiting');
    process.exit(0);
  });
  // Force exit after 10s if close hangs
  setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
