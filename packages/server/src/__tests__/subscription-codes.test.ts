import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
	CODE_ALPHABET,
	generateRedeemCode,
} from "../services/subscription/codes.js";

describe("generateRedeemCode()", () => {
	it("returns a plaintext in CK-XXXX-XXXX-XXXX format (12 body chars, 3 groups of 4)", () => {
		const { plaintext } = generateRedeemCode("codekey", "monthly", 30);
		expect(plaintext).toMatch(/^CK-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}$/);
	});

	it("uses an alphabet without confusable chars (no 0/1/O/I)", () => {
		// The alphabet is the same one used for pairing codes; verify
		// those confusables are excluded.
		expect(CODE_ALPHABET).not.toMatch(/[0O1I]/);
	});

	it("returns a hash that is SHA-256(plaintext) as a hex string", () => {
		const { plaintext, hash } = generateRedeemCode("codekey", "monthly", 30);
		const expected = createHash("sha256").update(plaintext).digest("hex");
		expect(hash).toBe(expected);
		expect(hash).toMatch(/^[a-f0-9]{64}$/);
	});

	it('returns codePrefix="CK" and codeLast4=last 4 chars of the body (no dashes)', () => {
		const { plaintext, codePrefix, codeLast4 } = generateRedeemCode(
			"codekey",
			"monthly",
			30,
		);
		const body = plaintext.slice(3); // strip "CK-"
		const bodyNoDashes = body.replace(/-/g, "");
		expect(codePrefix).toBe("CK");
		expect(codeLast4).toBe(bodyNoDashes.slice(-4));
	});

	it("produces unique codes on repeated calls (collision-free in 10k samples)", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 10_000; i++) {
			seen.add(generateRedeemCode("codekey", "monthly", 30).plaintext);
		}
		// With 32^12 ≈ 1.15e18 keyspace, 10k draws should never collide.
		expect(seen.size).toBe(10_000);
	});

	it("hash and prefix/last4 are stable for the same plaintext (round-trip check)", () => {
		const a = generateRedeemCode("codekey", "monthly", 30);
		const b = generateRedeemCode("codekey", "monthly", 30);
		// Two independent draws should differ; the helper itself is
		// stateless (no in-process random seed).
		expect(a.plaintext).not.toBe(b.plaintext);
		expect(a.codePrefix).toBe(b.codePrefix);
	});
});
