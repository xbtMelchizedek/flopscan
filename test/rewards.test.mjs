import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { reconcileRewards } from "../src/rewards.mjs";
import { documentedLeg, scheduledPeriodTotal } from "../src/schedule.mjs";

const TINY = { initialRewardPerBlock: "100000", halvingIntervalBlocks: "1000", maxHalvings: "5", distributionPeriodBlocks: "10" };

/** A synthetic chain that follows the documented split, with the miner leg paid only when `paid`. */
function synth(periodsPaid) {
  const periods = [];
  const counters = { miner: 0n, validator: 0n, agent: 0n, staker: 0n };
  periodsPaid.forEach((paid, i) => {
    const block = (i + 1) * 10;
    const total = scheduledPeriodTotal(block, TINY);
    const legs = Object.fromEntries(["miner", "validator", "agent", "staker"].map((l) => [l, documentedLeg(total, l)]));
    if (!paid) legs.miner = 0n;
    for (const l in legs) counters[l] += legs[l];
    periods.push({
      block: String(block),
      distributed: {
        period_blocks: "10", total_reward: String(total), miners_paid: paid ? "1" : "0",
        ...Object.fromEntries(Object.entries(legs).map(([l, v]) => [`${l}_share`, String(v)])),
      },
      failed: null,
      miner_rewards: paid ? [{ miner: "m1", amount: String(legs.miner), gn: "1" }] : [],
      miner_failures: [],
    });
  });
  const state = {
    pinned: { number: periodsPaid.length * 10 + 3, hash: "0xsynthetic" },
    lastDistributionBlock: String(periodsPaid.length * 10),
    consts: TINY,
    counters: Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, String(v)])),
  };
  return { state, periods };
}

test("agreeing sources reconcile; unpaid miner legs are findings, not errors", () => {
  const { state, periods } = synth([true, false, true]);
  const r = reconcileRewards(state, periods);
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
  assert.equal(r.periods, 3);
  assert.equal(r.periods_with_miners_paid, 2);
  assert.equal(BigInt(r.totals.unminted), documentedLeg(scheduledPeriodTotal(20, TINY), "miner"));
  assert.equal(r.rows[1].miner_leg_unminted, String(documentedLeg(scheduledPeriodTotal(20, TINY), "miner")));
});

test("a counter that disagrees with the event sum fails closed", () => {
  const { state, periods } = synth([true, true]);
  state.counters.agent = String(BigInt(state.counters.agent) + 1n);
  const r = reconcileRewards(state, periods);
  assert.equal(r.ok, false);
  assert.deepEqual(r.mismatches.map((m) => m.reason), ["agent_counter_not_event_sum"]);
});

test("a missing or unread period fails closed", () => {
  const { state, periods } = synth([true, true, true]);
  periods.splice(1, 1);
  assert.deepEqual(reconcileRewards(state, periods).mismatches.map((m) => m.reason).slice(0, 1), ["period_not_read"]);
  const again = synth([true, true]);
  again.periods[0].distributed = null;
  assert.equal(reconcileRewards(again.state, again.periods).mismatches[0].reason, "no_distribution_event");
});

test("a failed distribution is a finding that forfeits the pot, and counters still match", () => {
  const { state, periods } = synth([true, true]);
  const lost = periods[1].distributed;
  for (const l of ["miner", "validator", "agent", "staker"]) state.counters[l] = String(BigInt(state.counters[l]) - BigInt(lost[`${l}_share`]));
  periods[1] = { ...periods[1], distributed: null, failed: { error: "Arithmetic" }, miner_rewards: [] };
  const r = reconcileRewards(state, periods);
  assert.equal(r.ok, true, JSON.stringify(r.mismatches));
  assert.equal(r.findings[0].kind, "distribution_failed");
});

test("tampered events are caught: wrong pot, miner events not summing, miner above its leg", () => {
  const a = synth([true]);
  a.periods[0].distributed.total_reward = "1";
  assert.ok(reconcileRewards(a.state, a.periods).mismatches.some((m) => m.reason === "total_reward_not_schedule"));

  const b = synth([true]);
  b.periods[0].miner_rewards.push({ miner: "m2", amount: "5", gn: "1" });
  assert.ok(reconcileRewards(b.state, b.periods).mismatches.some((m) => m.reason === "miner_events_not_miner_share"));

  const c = synth([true]);
  const extra = BigInt(c.periods[0].distributed.miner_share) + 1n;
  c.periods[0].distributed.miner_share = String(extra);
  c.periods[0].miner_rewards[0].amount = String(extra);
  c.state.counters.miner = String(extra);
  assert.ok(reconcileRewards(c.state, c.periods).mismatches.some((m) => m.reason === "miner_share_above_leg"));
});

test("a validator leg off the documented split is reported as a finding", () => {
  const { state, periods } = synth([true]);
  periods[0].distributed.validator_share = String(BigInt(periods[0].distributed.validator_share) - 7n);
  state.counters.validator = periods[0].distributed.validator_share;
  const r = reconcileRewards(state, periods);
  assert.equal(r.ok, true);
  assert.equal(r.findings[0].kind, "validator_leg_off_split");
});

const fixtures = readdirSync(new URL("./fixtures/", import.meta.url)).filter((f) => f.startsWith("devnet-rewards-"));
for (const f of fixtures) {
  test(`recorded devnet fixture ${f} reconciles exactly`, () => {
    const { state, periods } = JSON.parse(readFileSync(new URL(`./fixtures/${f}`, import.meta.url)));
    const r = reconcileRewards(state, periods);
    assert.equal(r.ok, true, JSON.stringify(r.mismatches));
    assert.equal(r.periods, periods.length);
  });
}
