/**
 * Bundle entry point for the relay server.
 * Unlike src/index.ts, this always starts the server (no import.meta check,
 * which doesn't work in CJS bundles).
 */
import { buildApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is required');
  console.error('Example: DATABASE_URL=postgres://user:pass@host:5432/db node relay.cjs');
  process.exit(1);
}

if (!PUBLIC_BASE_URL) {
  console.error('FATAL: PUBLIC_BASE_URL environment variable is required');
  console.error('Example: PUBLIC_BASE_URL=https://81.70.235.58 (used to build pairUrl)');
  process.exit(1);
}

async function main() {
  const { app } = await buildApp(DATABASE_URL!);
  await app.listen({ port: PORT, host: HOST });
  console.log(`Relay server listening on ${HOST}:${PORT}, public base URL: ${PUBLIC_BASE_URL}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
