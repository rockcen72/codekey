/**
 * 批量生成订阅兑换码
 *
 * 用法:
 *   npx tsx src/scripts/mint-codes.ts monthly 5
 *   npx tsx src/scripts/mint-codes.ts yearly 3
 *
 * 环境变量:
 *   DATABASE_URL      — PostgreSQL 连接串（必需）
 *   MINT_BATCH_ID     — 批次号（可选，默认 YYYYMMDD）
 *   MINT_NOTE         — 备注（可选）
 */

import postgres from 'postgres';
import { mintCodes } from '../services/subscription/index.js';

const [plan, countStr] = process.argv.slice(2);
const count = parseInt(countStr, 10);

if (!plan || !['monthly', 'yearly'].includes(plan)) {
  console.error('用法: npx tsx src/scripts/mint-codes.ts <monthly|yearly> <数量>');
  console.error('示例: npx tsx src/scripts/mint-codes.ts monthly 5');
  process.exit(1);
}
if (!Number.isInteger(count) || count < 1 || count > 10_000) {
  console.error('数量必须是 1-10000 的整数');
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('需要设置 DATABASE_URL 环境变量');
  process.exit(1);
}

const sql = postgres(databaseUrl, { max: 1 });

try {
  const batchId = process.env.MINT_BATCH_ID || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const note = process.env.MINT_NOTE || undefined;

  const codes = await mintCodes(sql, 'codekey', plan, count, { batchId, note });

  console.log(`\n=== ${plan === 'monthly' ? '月卡' : '年卡'} x ${count} 张 ===`);
  console.log(`批次: ${batchId}`);
  for (const c of codes) {
    console.log(c.plaintext);
  }
  console.log('');
} catch (err) {
  console.error('生成失败:', err);
  process.exit(1);
} finally {
  await sql.end();
}
