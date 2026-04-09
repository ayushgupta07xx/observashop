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
const SERVICE_NAME = 'products-service';

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
interface Product {
  id: string;
  name: string;
  priceCents: number;
  stock: number;
  createdAt: string;
}

const products = new Map<string, Product>();
products.set('1', {
  id: '1',
  name: 'Mechanical Keyboard',
  priceCents: 12999,
  stock: 42,
  createdAt: new Date().toISOString(),
});
products.set('2', {
  id: '2',
  name: 'USB-C Hub',
  priceCents: 4599,
  stock: 128,
  createdAt: new Date().toISOString(),
});
products.set('3', {
  id: '3',
  name: 'Noise-Cancelling Headphones',
  priceCents: 29900,
  stock: 17,
  createdAt: new Date().toISOString(),
});

// ---------- Routes ----------

app.get('/healthz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok', service: SERVICE_NAME });
});

app.get('/readyz', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ready', service: SERVICE_NAME });
});

app.get('/metrics', async (_req: Request, res: Response) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

app.get('/products', (_req: Request, res: Response) => {
  res.json({ products: Array.from(products.values()) });
});

app.get('/products/:id', (req: Request, res: Response) => {
  const product = products.get(req.params.id as string);
  if (!product) {
    return res.status(404).json({ error: 'product not found' });
  }
  return res.json(product);
});

app.post('/products', (req: Request, res: Response) => {
  const { name, priceCents, stock } = req.body;
  if (!name || typeof priceCents !== 'number' || typeof stock !== 'number') {
    return res.status(400).json({ error: 'name, priceCents (number), and stock (number) are required' });
  }
  const id = (products.size + 1).toString();
  const product: Product = { id, name, priceCents, stock, createdAt: new Date().toISOString() };
  products.set(id, product);
  return res.status(201).json(product);
});

app.get('/', (_req: Request, res: Response) => {
  res.json({
    service: SERVICE_NAME,
    version: '1.0.0',
    endpoints: ['/healthz', '/readyz', '/metrics', '/products', '/products/:id'],
  });
});

// ---------- Start ----------
const server = app.listen(PORT, () => {
  logger.info({ port: PORT, service: SERVICE_NAME }, 'service started');
});

const shutdown = (signal: string) => {
  logger.info({ signal }, 'shutdown signal received');
  server.close(() => {
    logger.info('http server closed, exiting');
    process.exit(0);
  });
  setTimeout(() => {
    logger.error('forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
};

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
