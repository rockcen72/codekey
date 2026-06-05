// Pure redeem-code generation. The plaintext is shown to the user
// exactly once (at mint time); only the SHA-256 hash is stored.
//
// Format: CK-XXXX-XXXX-XXXX (12 body chars in 3 groups of 4, dashes
// for readability). 32-char alphabet, no 0/1/O/I to avoid
// transcription mistakes. Keyspace: 32^12 ≈ 1.15e18 — collision
// probability is negligible for any realistic batch size.

import { createHash, randomBytes } from "node:crypto";

export const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const CODE_PREFIX = "CK";
export const CODE_BODY_CHARS = 12;
export const CODE_GROUP_SIZE = 4;

export interface GeneratedCode {
	plaintext: string;
	hash: string;
	codePrefix: string;
	codeLast4: string;
}

export function generateRedeemCode(
	product: string,
	plan: string,
	durationDays: number,
): GeneratedCode {
	// product/plan/durationDays are accepted for forward-compatibility
	// (the future MoneyNote product, multi-plan prefixes) but the
	// Phase 2 format is product-agnostic. The prefix column stores "CK"
	// for any CodeKey subscription regardless of plan.
	void product;
	void plan;
	void durationDays;

	const bytes = randomBytes(CODE_BODY_CHARS);
	let body = "";
	for (let i = 0; i < CODE_BODY_CHARS; i++) {
		body += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
	}
	const plaintext = `${CODE_PREFIX}-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(8, 12)}`;
	const hash = createHash("sha256").update(plaintext).digest("hex");
	return {
		plaintext,
		hash,
		codePrefix: CODE_PREFIX,
		codeLast4: body.slice(-4),
	};
}
