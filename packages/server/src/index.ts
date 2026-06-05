import { buildApp } from './app.js';
import { validateEnv } from './config/validate-env.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const { DATABASE_URL, PUBLIC_BASE_URL } = validateEnv();

async function main() {
  const { app } = await buildApp(DATABASE_URL);
  await app.listen({ port: PORT, host: HOST });
  console.log(`Relay server listening on ${HOST}:${PORT}, public base URL: ${PUBLIC_BASE_URL}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
