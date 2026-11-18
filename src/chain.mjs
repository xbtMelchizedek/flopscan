// Read-only chain access. Every read in one call is pinned to one block hash, so the numbers
// we compare all describe the same state (the multicall-at-one-block habit from yearn-exporter).
// Nothing here signs or submits; the module never builds an extrinsic.

import { ApiPromise, WsProvider } from "@polkadot/api";

export const NETWORKS = Object.freeze({
  devnet: { rpc: "wss://rpc.devnet.flop.network", genesis: "0x99c172c095340ace980631f9123544c6bebd4839f3437e463533422d8be2d631" },
});

const VERIFIER_PALLETS = [
  "settlementSp1Pallet", "settlementGroth16Pallet", "settlementRisc0Pallet", "settlementPlonky2Pallet",
  "settlementFFlonkPallet", "settlementUltraplonkPallet", "settlementUltrahonkPallet", "settlementEzklPallet",
  "settlementTeePallet",
];

const CONNECT_TIMEOUT_MS = 60_000;

function withTimeout(promise, ms, what) {
  let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Connect and refuse any chain whose genesis is not the one pinned for `network`. */
export async function connect(network, rpcOverride) {
  const net = NETWORKS[network];
  if (!net) throw new Error(`unknown network ${network}; known: ${Object.keys(NETWORKS).join(", ")}`);
  // No auto-reconnect: a dropped socket is an error we report, not a loop we hide.
  const provider = new WsProvider(rpcOverride ?? net.rpc, false, {}, CONNECT_TIMEOUT_MS);
  await withTimeout(provider.connect(), CONNECT_TIMEOUT_MS, "rpc connect");
  const api = await withTimeout(ApiPromise.create({ provider, noInitWarn: true, throwOnConnect: true }), CONNECT_TIMEOUT_MS, "metadata");
  const genesis = api.genesisHash.toHex();
  if (genesis !== net.genesis) {
    await api.disconnect();
    throw new Error(`genesis ${genesis} is not ${network} (${net.genesis})`);
  }
  return api;
}

export async function pin(api, at) {
  const hash = at === undefined ? await api.rpc.chain.getFinalizedHead() : await api.rpc.chain.getBlockHash(at);
  const header = await api.rpc.chain.getHeader(hash);
  return { hash: hash.toHex(), number: header.number.toNumber() };
}

const big = (codec) => codec.toBigInt().toString();

export async function readRewardsState(api, pinned) {
  const at = await api.at(pinned.hash);
  const c = api.consts.blockRewards;
  const q = at.query.blockRewards;
  const [last, miner, validator, agent, staker] = await Promise.all([
    q.lastDistributionBlock(), q.totalMinerRewards(), q.totalValidatorRewards(), q.totalAgentRewards(), q.totalStakerRewards(),
  ]);
  return {
    pinned,
    lastDistributionBlock: last.toString(),
    consts: {
      initialRewardPerBlock: big(c.initialRewardPerBlock),
      halvingIntervalBlocks: c.halvingIntervalBlocks.toString(),
      maxHalvings: c.maxHalvings.toString(),
      distributionPeriodBlocks: c.distributionPeriodBlocks.toString(),
    },
    counters: { miner: big(miner), validator: big(validator), agent: big(agent), staker: big(staker) },
  };
}

/** The blockRewards events emitted at one distribution block, as plain JSON. */
export async function readPeriod(api, block) {
  const hash = await api.rpc.chain.getBlockHash(block);
  const events = await (await api.at(hash)).query.system.events();
  const out = { block: String(block), hash: hash.toHex(), distributed: null, failed: null, miner_rewards: [], miner_failures: [] };
  for (const { event } of events) {
    if (event.section !== "blockRewards") continue;
    const d = event.data;
    if (event.method === "RewardsDistributed") {
      out.distributed = {
        period_blocks: d[0].toString(), total_reward: big(d[1]), miner_share: big(d[2]), validator_share: big(d[3]),
        agent_share: big(d[4]), staker_share: big(d[5]), miners_paid: d[6].toString(),
      };
    } else if (event.method === "MinerRewarded") {
      out.miner_rewards.push({ miner: d[0].toString(), amount: big(d[1]), gn: d[2].toString() });
    } else if (event.method === "MinerRewardFailed") {
      out.miner_failures.push({ miner: d[0].toString(), amount: big(d[1]), gn: d[2].toString() });
    } else if (event.method === "DistributionFailed") {
      out.failed = { error: d[0].toString() };
    }
  }
  return out;
}

/** Issuance at both ends plus every issuance-changing balances event in (from, to]. */
export async function readIssuanceWindow(api, from, to, isIssuanceEvent) {
  const hashFrom = await api.rpc.chain.getBlockHash(from);
  const hashTo = await api.rpc.chain.getBlockHash(to);
  const [iFrom, iTo] = await Promise.all([
    (await api.at(hashFrom)).query.balances.totalIssuance(),
    (await api.at(hashTo)).query.balances.totalIssuance(),
  ]);
  const events = [];
  for (let n = from + 1; n <= to; n++) {
    const hash = await api.rpc.chain.getBlockHash(n);
    for (const { event } of await (await api.at(hash)).query.system.events()) {
      if (!isIssuanceEvent(event.section, event.method)) continue;
      const amount = event.method === "Issued" || event.method === "Rescinded" ? event.data[0] : event.data[1];
      events.push({ block: n, section: event.section, method: event.method, amount: big(amount) });
    }
  }
  return { from, to, issuance_from: big(iFrom), issuance_to: big(iTo), events };
}

/** Registered verifying keys and proof tickets per zkVerify-style settlement pallet. */
export async function readVerifiers(api, pinned) {
  const at = await api.at(pinned.hash);
  const rows = [];
  for (const pallet of VERIFIER_PALLETS) {
    const q = at.query[pallet];
    if (!q) {
      rows.push({ pallet, present: false });
      continue;
    }
    const [vks, tickets, disabled] = await Promise.all([q.vks.keys(), q.tickets.keys(), q.disabled()]);
    rows.push({ pallet, present: true, disabled: disabled.toJSON(), vks: vks.length, tickets: tickets.length });
  }
  return { pinned, rows };
}
