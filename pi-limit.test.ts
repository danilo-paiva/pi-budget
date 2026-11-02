// Run with: node --test pi-limit.test.ts   (Node 22.18+ strips TypeScript types natively)
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAmountForAxis } from "./pi-limit.ts";

test("tokens: thousands separators", () => {
	for (const raw of ["200,000", "200.000", "200_000", "200000", "200k", "200000 tokens"]) {
		assert.equal(parseAmountForAxis("tokens", raw), 200_000, raw);
	}
	assert.equal(parseAmountForAxis("tokens", "1.500.000"), 1_500_000);
	assert.equal(parseAmountForAxis("tokens", "1,5k"), 1500);
	assert.equal(parseAmountForAxis("tokens", "2m"), 2_000_000);
});

test("cost: comma is a decimal separator", () => {
	assert.equal(parseAmountForAxis("cost", "0,50"), 0.5);
	assert.equal(parseAmountForAxis("cost", "$0.50"), 0.5);
	assert.equal(parseAmountForAxis("cost", "2 usd"), 2);
});

test("time: minutes", () => {
	assert.equal(parseAmountForAxis("time", "30"), 30);
	assert.equal(parseAmountForAxis("time", "30 min"), 30);
	assert.equal(parseAmountForAxis("time", "1,5"), 1.5);
});

test("invalid values", () => {
	for (const raw of ["", "abc", "-1", "0", "0.00", "1.2.3"]) {
		assert.equal(parseAmountForAxis("cost", raw), undefined, raw);
	}
});
