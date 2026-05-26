import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildApp } from '../index.js';
import type { FastifyInstance } from 'fastify';
import type postgres from 'postgres';

const DATABASE_URL = process.env.DATABASE_URL;
const describeDb = DATABASE_URL ? describe : describe.skip;

describeDb('Server health', () => {
  let app: FastifyInstance;
  let sql: postgres.Sql;

  beforeAll(async () => {
    const built = await buildApp(DATABASE_URL!);
    app = built.app;
    sql = built.sql;
  });

  afterAll(async () => {
    await app.close();
    await sql.end();
  });

  it('responds with status ok', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.payload);
    expect(body.status).toBe('ok');
    expect(body.ts).toBeDefined();
  });
});
