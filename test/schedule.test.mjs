import assert from "node:assert/strict";
import { test } from "node:test";
import { documentedLeg, periodBoundaries, rewardAt, scheduledPeriodTotal } from "../src/schedule.mjs";

const E18 = 10n ** 18n;
// Runtime constants read from FLOP devnet (spec 1,014,027) on 18 Nov 2026.
const DEVNET = { initialRewardPerBlock: String(96n * E18), halvingIntervalBlocks: "63072000", maxHalvings: "5", distributionPeriodBlocks: "86400" };
const TINY = { initialRewardPerBlock: "96", halvingIntervalBlocks: "10", maxHalvings: "5", distributionPeriodBlocks: "4" };

test("devnet period pot is 86,400 x 96 FLOP (golden: RewardsDistributed at block 86,400)", () => {
  assert.equal(scheduledPeriodTotal(86_400, DEVNET), 8_294_400n * E18);
});

test("halving ladder ends at the documented 3 FLOP floor", () => {
  const at = (h) => rewardAt(h * 63_072_000 + 1, DEVNET) / E18;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 40].map(at), [96n, 48n, 24n, 12n, 6n, 3n, 3n, 3n]);
});

test("a period that crosses a halving sums both runs (second method: brute force)", () => {
  for (const end of [4, 8, 12, 20, 40, 60, 80]) {
    let brute = 0n;
    for (let b = end - 3; b <= end; b++) brute += rewardAt(b, TINY);
    assert.equal(scheduledPeriodTotal(end, TINY), brute, `end ${end}`);
  }
});

test("documented legs round down and never exceed the pot", () => {
  for (const total of [0n, 1n, 7n, 9_999n, 8_294_400n * E18 + 3n]) {
    const legs = ["miner", "validator", "agent", "staker"].map((l) => documentedLeg(total, l));
    assert.ok(legs.reduce((a, b) => a + b, 0n) <= total);
  }
  assert.equal(documentedLeg(8_294_400n * E18, "validator"), 829_440n * E18);
  assert.throws(() => documentedLeg(1n, "labs"), RangeError);
});

test("inputs that are not boundaries are refused, not rounded", () => {
  assert.throws(() => scheduledPeriodTotal(86_401, DEVNET), RangeError);
  assert.throws(() => periodBoundaries(86_401, 86_400), RangeError);
  assert.throws(() => rewardAt(0, DEVNET), RangeError);
  assert.deepEqual(periodBoundaries(12, 4), [4n, 8n, 12n]);
  assert.deepEqual(periodBoundaries(0, 4), []);
});
