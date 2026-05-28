/**
 * Bundle entry point for the relay server.
 * Unlike src/index.ts, this always starts the server (no import.meta check,
 * which doesn't work in CJS bundles).
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codekey:codekey@localhost:5432/codekey';

async function main() {
  const { app } = await buildApp(DATABASE_URL);
  await app.listen({ port: PORT, host: HOST });
  console.log(`Relay server listening on ${HOST}:${PORT}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
