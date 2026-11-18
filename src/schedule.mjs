// FLOP block-reward schedule, as integers (planck, 18 decimals). No floats anywhere.
//
// Chain constants (`blockRewards.initialRewardPerBlock`, `halvingIntervalBlocks`, `maxHalvings`,
// `distributionPeriodBlocks`) come from runtime metadata. The leg split is NOT a runtime constant;
// it is the documented split (docs.flop.network/docs/tokenomics-basics): 75% miners, 10% validators,
// 10% agents, 5% community stakers. We check the chain against that split, we do not assume it.

export const MAX_BPS = 10_000n;
export const DOCUMENTED_SPLIT_BPS = Object.freeze({ miner: 7_500n, validator: 1_000n, agent: 1_000n, staker: 500n });

/** Reward minted for block `n`: initial >> halvings, halvings capped at `maxHalvings`. */
export function rewardAt(n, { initialRewardPerBlock, halvingIntervalBlocks, maxHalvings }) {
  const block = BigInt(n);
  if (block < 1n) throw new RangeError(`block must be >= 1, got ${n}`);
  let halvings = (block - 1n) / BigInt(halvingIntervalBlocks); // assumption: block 1 is the first rewarded block
  if (halvings > BigInt(maxHalvings)) halvings = BigInt(maxHalvings);
  return BigInt(initialRewardPerBlock) >> halvings;
}

/** Scheduled pot for the period ending at `endBlock`: the sum over (endBlock - periodBlocks, endBlock]. */
export function scheduledPeriodTotal(endBlock, consts) {
  const end = BigInt(endBlock);
  const len = BigInt(consts.distributionPeriodBlocks);
  if (end % len !== 0n) throw new RangeError(`${endBlock} is not a period boundary (period ${len})`);
  const interval = BigInt(consts.halvingIntervalBlocks);
  let total = 0n;
  let b = end - len + 1n;
  while (b <= end) {
    // Walk in runs of equal reward so a period crossing a halving costs two steps, not 86,400.
    const nextHalving = ((b - 1n) / interval + 1n) * interval + 1n;
    const runEnd = nextHalving - 1n < end ? nextHalving - 1n : end;
    total += rewardAt(b, consts) * (runEnd - b + 1n);
    b = runEnd + 1n;
  }
  return total;
}

/** A documented leg of `total`, rounded down (the chain cannot mint more than the pot). */
export function documentedLeg(total, leg) {
  const bps = DOCUMENTED_SPLIT_BPS[leg];
  if (bps === undefined) throw new RangeError(`unknown leg ${leg}`);
  return (BigInt(total) * bps) / MAX_BPS;
}

/** Period boundaries in (0, lastDistributionBlock], oldest first. */
export function periodBoundaries(lastDistributionBlock, distributionPeriodBlocks) {
  const len = BigInt(distributionPeriodBlocks);
  const last = BigInt(lastDistributionBlock);
  if (last % len !== 0n) throw new RangeError(`lastDistributionBlock ${last} is not a multiple of ${len}`);
  const out = [];
  for (let b = len; b <= last; b += len) out.push(b);
  return out;
}
