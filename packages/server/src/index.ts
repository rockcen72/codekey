import { buildApp } from './app.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const HOST = process.env.HOST ?? '0.0.0.0';
const DATABASE_URL = process.env.DATABASE_URL;
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL;

if (!DATABASE_URL) {
  console.error('FATAL: DATABASE_URL environment variable is required');
  console.error('Example: DATABASE_URL=postgres://user:pass@host:5432/db node dist/index.js');
  process.exit(1);
}

if (!PUBLIC_BASE_URL) {
  console.error('FATAL: PUBLIC_BASE_URL environment variable is required');
  console.error('Example: PUBLIC_BASE_URL=https://81.70.235.58 (used to build pairUrl)');
  process.exit(1);
}
// Validate and normalize (remove trailing slash and path, strictly http/https)
let normalizedBaseUrl: string;
{
  let parsed: URL;
  try {
    parsed = new URL(PUBLIC_BASE_URL);
  } catch {
    console.error('FATAL: PUBLIC_BASE_URL is not a valid URL: %s', PUBLIC_BASE_URL);
    process.exit(1);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    console.error('FATAL: PUBLIC_BASE_URL must be http or https: %s', PUBLIC_BASE_URL);
    process.exit(1);
  }
  normalizedBaseUrl = `${parsed.protocol}//${parsed.host}`;
}
// Override env so the rest of the app uses the normalized value
process.env.PUBLIC_BASE_URL = normalizedBaseUrl;

async function main() {
  const { app } = await buildApp(DATABASE_URL!);
  await app.listen({ port: PORT, host: HOST });
  console.log(`Relay server listening on ${HOST}:${PORT}, public base URL: ${PUBLIC_BASE_URL}`);
}

main().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
