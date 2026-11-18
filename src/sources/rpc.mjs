// Chain-side readers for the v1 metrics. Each takes an `at` (api.at(blockHash)) so a group of
// reads describes one block. Read-only: nothing here builds an extrinsic.

import { RetryableError, withRetry } from "../polite.mjs";

const big = (codec) => codec.toBigInt().toString();
const KEY_PAGE = 1000;

/**
 * The public RPC sits behind a load balancer whose backends sync at different speeds, so a block
 * the explorer has indexed can be unknown to the backend we hit. Wait for it (bounded), then fail.
 */
export async function waitForBlock(api, hash, { attempts = 8, wait } = {}) {
  return withRetry(async () => {
    try {
      const header = await api.rpc.chain.getHeader(hash);
      return { hash: header.hash.toHex(), number: header.number.toNumber() };
    } catch (e) {
      throw new RetryableError(`block ${hash} not on this RPC backend yet: ${e.message}`);
    }
  }, { attempts, base: 2000, cap: 15_000, wait });
}

/** The block hash and number the explorer indexed, re-checked on chain. */
export async function blockAt(api, hash) {
  const header = await waitForBlock(api, hash);
  const at = await api.at(hash);
  const now = await at.query.timestamp.now();
  return { ...header, time_ms: Number(now.toBigInt()) };
}

/** Number of keys under a storage map, by paging state_getKeysPaged at one block. */
export async function countKeys(api, entry, hash) {
  const prefix = entry.keyPrefix();
  let start = prefix;
  let n = 0;
  for (;;) {
    const page = await api.rpc.state.getKeysPaged(prefix, KEY_PAGE, start, hash);
    n += page.length;
    if (page.length < KEY_PAGE) return n;
    start = page[page.length - 1].toHex();
  }
}

/** Counters that the runtime keeps as single values, read at one block. Missing items are null. */
export async function readCounters(api, hash) {
  const at = await api.at(hash);
  const q = at.query;
  const opt = async (fn) => { try { return await fn(); } catch { return null; } };
  const [
    minerPaid, burned, refunded, gnCredited, escrowReserved, bondLocked, bondReleased, bondSlashed,
    agentCount, nextAgentId, globalStats, totalWallets, totalMiners, ghostIssued, ghostCompleted, ghostExpired, ghostIncorrect,
    totalSessions, issuance, labsSubsidy, foundationSubsidy, validators, lastUpgrade,
  ] = await Promise.all([
    opt(() => q.computeChannel.totalMinerPaid()), opt(() => q.computeChannel.totalBurned()), opt(() => q.computeChannel.totalRefunded()),
    opt(() => q.computeChannel.totalGnCredited()), opt(() => q.computeChannel.totalEscrowReserved()),
    opt(() => q.computeChannel.totalForwardBondLocked()), opt(() => q.computeChannel.totalForwardBondReleased()), opt(() => q.computeChannel.totalForwardBondSlashed()),
    opt(() => q.agentIdentity.agentCount()), opt(() => q.agentIdentity.nextAgentId()), opt(() => q.agentIdentity.globalStats()),
    opt(() => q.agentWallet.totalWallets()), opt(() => q.minerStaking.totalMiners()),
    opt(() => q.syntheticTasks.totalIssued()), opt(() => q.syntheticTasks.totalCompleted()), opt(() => q.syntheticTasks.totalExpired()), opt(() => q.syntheticTasks.totalIncorrect()),
    opt(() => q.flopSessionKeys.totalSessions()), opt(() => q.balances.totalIssuance()),
    opt(() => q.flopSubsidy.totalLabsSubsidy()), opt(() => q.flopSubsidy.totalFoundationSubsidy()),
    opt(() => q.session.validators()), opt(() => q.system.lastRuntimeUpgrade()),
  ]);
  const s = (c) => (c == null ? null : c.toBigInt ? big(c) : c.toString());
  const gs = globalStats?.toJSON?.() ?? null;
  return {
    compute: { miner_paid: s(minerPaid), burned: s(burned), refunded: s(refunded), gn_credited: s(gnCredited), escrow_reserved: s(escrowReserved) },
    forward: { bond_locked: s(bondLocked), bond_released: s(bondReleased), bond_slashed: s(bondSlashed) },
    agents: { agent_count: s(agentCount), next_agent_id: s(nextAgentId), global_total_agents: gs?.totalAgents == null ? null : String(gs.totalAgents) },
    wallets: { total_wallets: s(totalWallets) },
    miners: { total_miners: s(totalMiners) },
    ghost: { issued: s(ghostIssued), completed: s(ghostCompleted), expired: s(ghostExpired), incorrect: s(ghostIncorrect) },
    sessions: { total_sessions: s(totalSessions) },
    supply: { total_issuance: s(issuance), labs_subsidy: s(labsSubsidy), foundation_subsidy: s(foundationSubsidy) },
    validators: { session_validators: validators == null ? null : String(validators.length) },
    runtime: lastUpgrade == null || lastUpgrade.isNone ? null : (() => { const u = lastUpgrade.unwrap(); return { spec_name: u.specName.toString(), spec_version: u.specVersion.toNumber() }; })(),
  };
}

/** Storage-map sizes that have a counterpart elsewhere. */
export async function readKeyCounts(api, hash) {
  const q = api.query;
  const n = async (entry) => { try { return String(await countKeys(api, entry, hash)); } catch { return null; } };
  return {
    miners: await n(q.minerStaking.miners),
    agents: await n(q.agentIdentity.agents),
    channels: await n(q.computeChannel.channels),
    funded_forward_offers: await n(q.computeChannel.fundedForwardOffers),
    forward_positions: await n(q.computeChannel.forwardPositions),
    forward_bids: await n(q.computeChannel.forwardBids),
    forward_listings: await n(q.computeChannel.forwardListings),
  };
}

/** Per-miner staking records and ghost-task (liveness probe) stats, at one block. */
export async function readMinerTables(api, hash, { withMiners = true } = {}) {
  const at = await api.at(hash);
  const miners = new Map();
  if (withMiners) for (const [k, v] of await at.query.minerStaking.miners.entries()) {
    const j = v.toJSON();
    if (!j) continue;
    miners.set(k.args[0].toString(), { is_active: Boolean(j.isActive), total_rewards_earned: BigInt(j.totalRewardsEarned ?? 0).toString(), registered_at: String(j.registeredAt ?? "") });
  }
  const ghost = new Map();
  for (const [k, v] of await at.query.syntheticTasks.minerGhostStatsStore.entries()) {
    const j = v.toJSON();
    if (!j) continue;
    ghost.set(k.args[0].toString(), { issued: String(j.totalIssued ?? 0), completed: String(j.totalCompleted ?? 0), expired: String(j.totalExpired ?? 0), incorrect: String(j.totalIncorrect ?? 0) });
  }
  return { miners: Object.fromEntries(miners), ghost: Object.fromEntries(ghost) };
}

/** Free balance and nonce of one account at one block. */
export async function readAccount(api, hash, address) {
  const at = await api.at(hash);
  const a = await at.query.system.account(address);
  return { free: big(a.data.free), reserved: big(a.data.reserved), nonce: a.nonce.toString() };
}

/** Events of one block as {section, method, data} with data as JSON. */
export async function readBlockEvents(api, hashOrNumber) {
  const hash = typeof hashOrNumber === "number" ? await api.rpc.chain.getBlockHash(hashOrNumber) : hashOrNumber;
  const events = await (await api.at(hash)).query.system.events();
  return events.map(({ event, phase }) => ({
    section: event.section, method: event.method, data: event.data.toJSON(),
    extrinsic_index: phase.isApplyExtrinsic ? phase.asApplyExtrinsic.toNumber() : null,
  }));
}

/** Runtime spec at a block number (one state_getRuntimeVersion call, via the block's hash). */
export async function specAt(api, n) {
  const hash = await api.rpc.chain.getBlockHash(n);
  const v = await api.rpc.state.getRuntimeVersion(hash);
  return { block: n, hash: hash.toHex(), spec_name: v.specName.toString(), spec_version: v.specVersion.toNumber() };
}
