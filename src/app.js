import express from 'express';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import { apiRouter } from './routes/api.js';
import { AppError } from './errors.js';
import { securityHeaders } from './security.js';

export function createApp(pool, options = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());
  app.use('/api', apiRouter(pool, options));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }));
  app.use(express.static(fileURLToPath(new URL('../public', import.meta.url))));

  app.use((err, _req, res, _next) => {
    if (err instanceof AppError) return res.status(err.status).json({ error: err.message, details: err.details });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
    // Safety net: database rejected a value (bad number/format, CHECK constraint) → client error, not 500.
    if (['22P02', '22003', '22007', '22008', '23514'].includes(err.code)) return res.status(400).json({ error: 'Invalid value in request' });
    console.error(err);
    res.status(500).json({ error: 'Internal server error' });
  });
  return app;
}
