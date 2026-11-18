// Reconcile FLOP block rewards three ways, in the shape of banteg/yearn-fees: a number is only
// reported as settled when the independent sources agree.
//   A. per-period `blockRewards.RewardsDistributed` events (what each distribution said it minted)
//   B. cumulative `blockRewards.total*Rewards` counters read at one pinned block
//   C. the schedule recomputed from runtime constants and the documented split
// A must equal B exactly (else `ok: false`). A vs C is reported as findings: on devnet the miner
// leg is only minted for miners with verified G_n, so a shortfall there is expected, not an error.

import { documentedLeg, periodBoundaries, scheduledPeriodTotal } from "./schedule.mjs";

const LEGS = ["miner", "validator", "agent", "staker"];

/**
 * @param {object} state   { consts, counters, lastDistributionBlock } from chain.readRewardsState
 * @param {object[]} periods  one record per boundary from chain.readPeriod, oldest first
 */
export function reconcileRewards(state, periods) {
  const { consts, counters } = state;
  const mismatches = [];
  const findings = [];
  const byBlock = new Map(periods.map((p) => [BigInt(p.block), p]));
  const sums = Object.fromEntries(LEGS.map((l) => [l, 0n]));
  const rows = [];

  for (const block of periodBoundaries(state.lastDistributionBlock, consts.distributionPeriodBlocks)) {
    const p = byBlock.get(block);
    const scheduled = scheduledPeriodTotal(block, consts);
    if (!p) {
      mismatches.push({ block: String(block), reason: "period_not_read" });
      continue;
    }
    const d = p.distributed;
    if (!d) {
      if (p.failed) {
        findings.push({ block: String(block), kind: "distribution_failed", forfeited: String(scheduled) });
        rows.push({ block: String(block), scheduled: String(scheduled), failed: true });
      } else {
        mismatches.push({ block: String(block), reason: "no_distribution_event" });
      }
      continue;
    }
    if (BigInt(d.total_reward) !== scheduled) {
      mismatches.push({ block: String(block), reason: "total_reward_not_schedule", event: d.total_reward, schedule: String(scheduled) });
    }
    for (const leg of ["validator", "agent", "staker"]) {
      const want = documentedLeg(scheduled, leg);
      const got = BigInt(d[`${leg}_share`]);
      if (got !== want) findings.push({ block: String(block), kind: `${leg}_leg_off_split`, documented: String(want), minted: String(got) });
    }
    const minerSum = p.miner_rewards.reduce((a, r) => a + BigInt(r.amount), 0n);
    if (minerSum !== BigInt(d.miner_share)) {
      mismatches.push({ block: String(block), reason: "miner_events_not_miner_share", miner_rewarded_sum: String(minerSum), miner_share: d.miner_share });
    }
    const minerLeg = documentedLeg(scheduled, "miner");
    const forfeited = minerLeg - BigInt(d.miner_share);
    if (forfeited < 0n) mismatches.push({ block: String(block), reason: "miner_share_above_leg" });
    for (const leg of LEGS) sums[leg] += BigInt(d[`${leg}_share`]);
    rows.push({
      block: String(block),
      scheduled: String(scheduled),
      miner_share: d.miner_share,
      miner_leg_unminted: String(forfeited),
      miners_paid: d.miners_paid,
      miner_reward_failures: p.miner_failures.length,
    });
  }

  for (const leg of LEGS) {
    const counter = BigInt(counters[leg]);
    if (counter !== sums[leg]) {
      mismatches.push({ reason: `${leg}_counter_not_event_sum`, counter: String(counter), events: String(sums[leg]) });
    }
  }

  const scheduledTotal = rows.reduce((a, r) => a + BigInt(r.scheduled), 0n);
  const minted = LEGS.reduce((a, l) => a + sums[l], 0n);
  return {
    ok: mismatches.length === 0,
    pinned: state.pinned,
    last_distribution_block: String(state.lastDistributionBlock),
    periods: rows.length,
    periods_with_miners_paid: rows.filter((r) => r.miners_paid && Number(r.miners_paid) > 0).length,
    totals: {
      scheduled: String(scheduledTotal),
      minted: String(minted),
      unminted: String(scheduledTotal - minted),
      ...Object.fromEntries(LEGS.map((l) => [l, String(sums[l])])),
    },
    mismatches,
    findings,
    rows,
  };
}
