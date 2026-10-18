import { createApp } from './app.js';
import { createPool } from './db.js';
import { config } from './config.js';
import { today } from './dates.js';

const pool = createPool();
const server = createApp(pool).listen(config.port, () => {
  console.log(`PharmaStock on http://localhost:${config.port}  (business date ${today()}, tz ${config.tz})`);
});

const shutdown = () => server.close(() => pool.end().then(() => process.exit(0)));
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
