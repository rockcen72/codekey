import { pathToFileURL } from 'node:url';
import { buildApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://codekey:codekey@localhost:5432/codekey';

async function main() {
  const { app } = await buildApp(DATABASE_URL);
  await app.listen({ port: PORT, host: HOST });
  console.log(`Relay server listening on ${HOST}:${PORT}`);
}

// Only start server when run directly, not when imported as a module
const isDirectRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isDirectRun) {
  main().catch((err) => {
    console.error('Failed to start server:', err);
    process.exit(1);
  });
}
