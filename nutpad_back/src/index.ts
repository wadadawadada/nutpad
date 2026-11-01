import { config } from './config.js';
import { openDb } from './db.js';
import { Mint } from './mint.js';
import { createLnBackend } from './ln.js';
import { createApp } from './app.js';
import { startWorker } from './worker.js';

const db = await openDb();
const mint = new Mint(db);
await mint.init();
mint.ln = createLnBackend(db, mint.seed);

const app = createApp(mint);
const server = app.listen(config.port, '0.0.0.0', () => {
  console.log(`[nutpad] api on :${config.port} | db=${config.databaseUrl ? 'postgres' : 'pglite'} | mint pubkey ${mint.nostrPk}`);
  console.log(`[nutpad] lightning: ${mint.ln ? `${mint.ln.name} (${mint.ln.network})` : 'disabled'}`);
  if (config.demoFaucet) console.warn('[nutpad] DEMO FAUCET ENABLED - sat ecash is not backed by any BTC');
});

const stopWorker = config.runWorker ? startWorker(mint) : () => {};

const shutdown = async () => {
  stopWorker();
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
