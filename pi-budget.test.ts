// Run with: node --test pi-budget.test.ts   (Node 22.18+ strips TypeScript types natively)
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseAmountForAxis, parseScopeArgument } from "./pi-budget.ts";

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

test("scope: prompt and session aliases", () => {
	for (const raw of ["prompt", "Prompt", " per-prompt ", "per_prompt", "per prompt"]) {
		assert.equal(parseScopeArgument(raw), "prompt", raw);
	}
	for (const raw of ["session", "SESSION", "per-session", "per session"]) {
		assert.equal(parseScopeArgument(raw), "session", raw);
	}
	for (const raw of ["", "0.5", "cost", "sessions", "prompts", "turn"]) {
		assert.equal(parseScopeArgument(raw), undefined, raw);
	}
});
