#!/usr/bin/env node
// Mint a batch of CodeKey redeem codes.
//
// Usage:
//   node scripts/mint-codes.js <product> <plan> <count> [--batch <id>] [--note <text>]
//
// Example:
//   node scripts/mint-codes.js codekey monthly 5 --batch 2026-06-launch --note "launch promo"
//
// Reads DATABASE_URL from the environment (or .env). Prints the
// plaintext codes to stdout, one per line — this is the ONLY time
// the plaintext is ever shown. Only the SHA-256 hash is stored.
//
// The script intentionally does NOT add a TypeScript build step —
// it imports the compiled .js directly from the server package.
// Run `npm run build -w @codekey/server` first if dist/ is stale.

import { config as loadDotenv } from "dotenv";
loadDotenv();

import postgres from "postgres";
import {
	MVP_PRODUCT,
	mintCodes,
} from "../packages/server/dist/services/subscription/index.js";

function parseArgs(argv) {
	const positional = [];
	const flags = {};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--batch") {
			flags.batchId = argv[++i];
			continue;
		}
		if (a === "--note") {
			flags.note = argv[++i];
			continue;
		}
		if (a === "--help" || a === "-h") {
			flags.help = true;
			continue;
		}
		positional.push(a);
	}
	return { positional, flags };
}

function help() {
	console.log(`Mint a batch of CodeKey redeem codes.

Usage:
  node scripts/mint-codes.js <product> <plan> <count> [--batch <id>] [--note <text>]

Arguments:
  product   "codekey" (only supported product in Phase 2)
  plan      "monthly" (30 days) or "yearly" (365 days)
  count     integer in [1, 10000]

Options:
  --batch   batch identifier (stored in redeem_codes.batch_id)
  --note    free-form text (stored in redeem_codes.note)
  --help    show this help

DATABASE_URL must be set (or present in .env).`);
}

async function main() {
	const { positional, flags } = parseArgs(process.argv.slice(2));
	if (flags.help) {
		help();
		process.exit(0);
	}

	const [productArg, planArg, countArg] = positional;
	if (!productArg || !planArg || !countArg) {
		console.error("error: missing required arguments\n");
		help();
		process.exit(2);
	}
	if (productArg !== MVP_PRODUCT) {
		console.error(
			`error: unsupported product "${productArg}" (Phase 2 only supports "${MVP_PRODUCT}")`,
		);
		process.exit(2);
	}
	if (planArg !== "monthly" && planArg !== "yearly") {
		console.error('error: plan must be "monthly" or "yearly"');
		process.exit(2);
	}
	const count = Number(countArg);
	if (!Number.isInteger(count) || count < 1 || count > 10_000) {
		console.error("error: count must be an integer in [1, 10000]");
		process.exit(2);
	}

	const databaseUrl = process.env.DATABASE_URL;
	if (!databaseUrl) {
		console.error("error: DATABASE_URL is not set");
		process.exit(2);
	}

	const sql = postgres(databaseUrl, {
		max: 2,
		idle_timeout: 5,
		connect_timeout: 10,
	});
	try {
		const codes = await mintCodes(sql, productArg, planArg, count, {
			batchId: flags.batchId,
			note: flags.note,
		});
		for (const c of codes) {
			console.log(c.plaintext);
		}
		if (flags.batchId) {
			console.error(
				`\nBatch: ${flags.batchId} — ${codes.length} codes minted.`,
			);
		} else {
			console.error(
				`\nMinted ${codes.length} codes. Save the plaintexts above now — they will not be shown again.`,
			);
		}
	} finally {
		await sql.end();
	}
}

main().catch((err) => {
	console.error("mint-codes failed:", err);
	process.exit(1);
});
