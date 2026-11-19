// A small deterministic FLOP world for tests: a fake chain (the readers shape scan.mjs uses) and a
// fake explorer + faucet + registry behind one fetch-like function. Knobs let a test make the two
// sides disagree, return junk, or fail.

const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const T0 = Date.UTC(2026, 10, 18, 12, 0, 0);
export const SIGNER = "5DZsAQuavUAM7A6XvoTkDQgtQdRCMcALdUd6Bx4FSoFMF8ux";
const MINERS = ["5Fminer1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "5Fminer2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "5Fminer3ccccccccccccccccccccccccccccccccccccccc"];
const CONSTS = { initialRewardPerBlock: "1000", halvingIntervalBlocks: "100000", maxHalvings: "5", distributionPeriodBlocks: "100" };
const POT = 1000n * 100n;
const AGENTS = [1, 2, 3].map((i) => ({ agent_id: `0x${String(i).repeat(64)}`, owner: `5Owner${i}`, registered_at: 400 + i }));

export function makeWorld(knobs = {}) {
  const head = knobs.head ?? 1000;
  const lo = knobs.lo ?? head - 5;
  const upgrades = knobs.upgrades ?? [300, 700];
  const calls = { period: 0, specAt: 0, blockEvents: 0, counters: 0, http: 0 };
  // Reward periods at 100, 200, ...: miner 1 paid in odd periods.
  const periods = {};
  const counters = { miner: 0n, validator: 0n, agent: 0n, staker: 0n };
  for (let b = 100; b <= Math.floor(head / 100) * 100; b += 100) {
    const paid = (b / 100) % 2 === 1;
    const miner = paid ? (POT * 7500n) / 10000n : 0n;
    const legs = { miner, validator: (POT * 1000n) / 10000n, agent: (POT * 1000n) / 10000n, staker: (POT * 500n) / 10000n };
    for (const k in legs) counters[k] += legs[k];
    periods[b] = { block: String(b), hash: H(b), distributed: { period_blocks: "100", total_reward: String(POT), miner_share: String(miner), validator_share: String(legs.validator), agent_share: String(legs.agent), staker_share: String(legs.staker), miners_paid: paid ? "1" : "0" }, failed: null, miner_rewards: paid ? [{ miner: MINERS[0], amount: String(miner), gn: "1" }] : [], miner_failures: [] };
  }
  const minerEarned = counters.miner;
  const spec = (n) => `rt ${100 + upgrades.filter((u) => u <= n).length}`;
  const settle = []; // explorer settlement rows, newest first
  const nSettle = knobs.settlements ?? 25;
  for (let i = 0; i < nSettle; i++) { const b = head - Math.floor((i * 175) / nSettle); settle.push({ channelId: H(5000 + i), settledBlock: b, settledBlockHash: H(b), eventIndex: 1, minerPaid: String(1000 + i), burned: "0", aggregateGn: String(10 + i), marketKind: "spot", settlementKind: "settled" }); }
  const paidUpTo = (b) => settle.filter((r) => r.settledBlock <= b).reduce((a, r) => a + BigInt(r.minerPaid), 0n);
  const ghost = (end) => Object.fromEntries(MINERS.map((m, i) => [m, { issued: String(100 + i * 10 + (end === "hi" ? 1 : 0)), completed: String(99 + i * 10 + (end === "hi" ? 1 : 0)), expired: "1", incorrect: "0" }]));
  const block = (n) => ({ hash: H(n), number: n, time_ms: T0 + n * 1000 });
  const byHash = (h) => parseInt(h.slice(2), 16);

  const readers = {
    head: async () => H(head),
    blockAt: async (h) => block(byHash(h)),
    counters: async (h) => {
      calls.counters++;
      const n = byHash(h); const end = n === head ? "hi" : "lo";
      return {
        compute: { miner_paid: String(paidUpTo(n) + BigInt(knobs.minerPaidSkew ?? 0)), burned: "0", refunded: "5", gn_credited: "7", escrow_reserved: "9" },
        forward: { bond_locked: "0", bond_released: "0", bond_slashed: "0" },
        agents: { agent_count: "42", next_agent_id: "42", global_total_agents: "42" },
        wallets: { total_wallets: end === "hi" ? "11" : "10" },
        miners: { total_miners: "3" },
        ghost: { issued: "330", completed: "327", expired: "3", incorrect: "0" },
        sessions: { total_sessions: "17" },
        supply: { total_issuance: String(10n ** 24n + BigInt(n) * 16n), labs_subsidy: "1", foundation_subsidy: "1" },
        validators: { session_validators: "4" },
        runtime: { spec_name: "rt", spec_version: 100 + upgrades.filter((u) => u <= n).length },
      };
    },
    keys: async () => ({ miners: "3", agents: "42", channels: "77", funded_forward_offers: "0", forward_positions: "0", forward_bids: "0", forward_listings: "0" }),
    minerTables: async (h, { withMiners = true } = {}) => {
      const end = byHash(h) === head ? "hi" : "lo";
      return { miners: withMiners ? Object.fromEntries(MINERS.map((m, i) => [m, { is_active: true, total_rewards_earned: knobs.storageEarned ?? "0", registered_at: "1" }])) : {}, ghost: ghost(end) };
    },
    account: async (h) => { const n = byHash(h); return { free: String(10n ** 20n - BigInt(n)), reserved: "0", nonce: String(n) }; },
    verifiers: async (pin) => ({ pinned: pin, rows: ["settlementSp1Pallet", "settlementGroth16Pallet", "settlementRisc0Pallet", "settlementPlonky2Pallet", "settlementFFlonkPallet", "settlementUltraplonkPallet", "settlementUltrahonkPallet", "settlementEzklPallet", "settlementTeePallet"].map((pallet) => ({ pallet, present: true, disabled: false, vks: pallet === "settlementSp1Pallet" ? 1 : 0, tickets: 0 })) }),
    rewardsState: async (pin) => ({ pinned: pin, lastDistributionBlock: String(Math.floor(head / 100) * 100), consts: CONSTS, counters: Object.fromEntries(Object.entries(counters).map(([k, v]) => [k, String(v)])) }),
    period: async (b) => { calls.period++; if (knobs.failPeriodAt === b) throw new Error("rpc 503"); return structuredClone(periods[b]); },
    specAt: async (n) => { calls.specAt++; const [name, v] = spec(n).split(" "); return { block: n, hash: H(n), spec_name: name, spec_version: Number(v) }; },
    blockEvents: async (x) => {
      calls.blockEvents++;
      const n = typeof x === "number" ? x : byHash(x);
      const evs = [];
      if (upgrades.includes(n)) evs.push({ section: "system", method: "CodeUpdated", data: [] });
      for (const r of settle.filter((r) => r.settledBlock === n)) evs.push({ section: "computeChannel", method: "Settled", data: [r.channelId, r.minerPaid, r.burned, r.aggregateGn, true] });
      for (const a of AGENTS) if (a.registered_at === n && knobs.dropAgentEvent !== n) evs.push({ section: "agentIdentity", method: "AgentRegistered", data: [a.agent_id, a.owner, "name", "did", "Autonomous"] });
      if (n === 900) evs.push({ section: "settlementSp1Pallet", method: "ProofVerified", data: ["0xab"] });
      return evs;
    },
    agents: async () => (knobs.agentsDown ? null : AGENTS.map((a) => ({ ...a }))),
    disconnect: async () => {},
  };

  const exStats = { registeredMiners: 3, activeAgents: 11, totalSupply: String(10n ** 24n + BigInt(lo + 2) * 16n), activeValidators: 4 };
  const routes = {
    "/api/health": () => ({ status: "ok", writer: { indexedHead: lo, indexedHash: H(lo) } }),
    "/api/stats": () => exStats,
    "/api/rewards/summary": () => ({ totalDistributed: String(BigInt(Object.keys(periods).length) * POT), totalMinerRewards: String(counters.miner), totalValidatorRewards: String(counters.validator), distributionCount: Object.keys(periods).length }),
    "/api/rewards/distributions": () => Object.values(periods).map((p) => ({ id: `reward-${p.block}`, block_number: Number(p.block), total_reward: p.distributed.total_reward, miner_share: p.distributed.miner_share, validator_share: p.distributed.validator_share, miners_paid: Number(p.distributed.miners_paid) })),
    "/api/inference-spend": () => ({ totalSpentRaw: String(paidUpTo(lo)), settledChannels: settle.filter((r) => r.settledBlock <= lo).length }),
    "/api/agent-wallets": () => ({ data: [], pagination: { total: 11 } }),
    "/api/sessions": () => ({ data: [], pagination: { total: 17 } }),
    "/api/compute-channels": () => ({ data: [], pagination: { total: 77 } }),
    "/api/miners": () => MINERS.map((m, i) => ({ address: m, totalRewards: i === 0 ? String(minerEarned) : "0", isActive: true })),
    "/api/miner-reliability": () => MINERS.map((m, i) => ({ miner: m, ghost: { issued: 100 + i * 10, completed: 99 + i * 10, expired: 1, incorrect: 0 } })),
    "/api/term-curve": () => ({ methodologyVersion: "v0", days: 90, history: [{ day: "2026-11-18", tenorDays: 1, tradeCount: 0, publishable: false }] }),
    "/api/operator-releases": () => ({ cli: { latest: "0.1.9", minimum: "0.1.1", image: `ghcr.io/flop-labs/flop-core/cli:v0.1.9@sha256:${"a".repeat(64)}` } }),
    "/api/transactions/sections": () => ({ data: [{ section: "settlementSp1Pallet", count: 1 }] }),
    "/api/transactions": () => [{ hash: H(77), blockHash: H(900), method: "submitProof", success: true, timestamp: T0, events: [{ section: "settlementSp1Pallet", method: "ProofVerified" }] }],
    "/api/settlement-prices": (q) => { const off = Number(q.get("offset") ?? 0); const lim = Number(q.get("limit") ?? 100); return { data: settle.slice(off, off + lim), pagination: { total: settle.length, limit: lim, offset: off, hasMore: off + lim < settle.length } }; },
    [`/api/accounts/${SIGNER}`]: () => (knobs.faucetExplorerBalance === undefined
      ? { address: SIGNER, balance: "0", liveBalance: false, txCount: lo + 1 + 3 }
      : { address: SIGNER, balance: knobs.faucetExplorerBalance, liveBalance: true, txCount: lo + 1 + 3 }),
    // The fake faucet signs one transaction per block (nonce at block n is n); every 50th block it
    // also receives a refill, which the list shows with another sender. Newest first, bare array.
    [`/api/accounts/${SIGNER}/transactions`]: (q) => {
      const rows = [];
      for (let b = lo; b >= 1; b--) {
        rows.push({ hash: H(1_000_000 + b), sender: knobs.faucetSender?.(b) ?? SIGNER, timestamp: T0 + b * 1000, success: true });
        if (b % 50 === 0) rows.push({ hash: H(2_000_000 + b), sender: MINERS[1], timestamp: T0 + b * 1000, success: true });
      }
      const off = Number(q.get("offset") ?? 0); const lim = Number(q.get("limit") ?? 100);
      return { __raw: rows.slice(off, off + lim) };
    },
    "/limits": () => ({ faucet: { signer: SIGNER, balanceFlop: "100" }, asOf: "2026-11-18T12:00:00Z" }),
    "/token": () => ({ token: "anonymous-test-token" }),
  };
  const paginate = (rows, q) => { const off = Number(q.get("offset") ?? 0); const lim = Number(q.get("limit") ?? 100); return { data: rows.slice(off, off + lim), pagination: { total: rows.length, limit: lim, offset: off, hasMore: off + lim < rows.length } }; };

  const getJson = async (url) => {
    calls.http++;
    const u = new URL(url);
    if (knobs.httpDown?.(u.pathname)) throw new Error(`GET ${url}: HTTP 503`);
    const route = routes[u.pathname];
    if (!route) throw new Error(`GET ${url}: HTTP 404`);
    const override = knobs.explorer?.[u.pathname];
    let body = override !== undefined ? (typeof override === "function" ? override(u.searchParams) : override) : route(u.searchParams);
    if (body && Array.isArray(body.__raw)) body = body.__raw;
    else if (Array.isArray(body)) body = paginate(body, u.searchParams);
    return structuredClone(body);
  };
  const fetchImpl = async () => ({ ok: true, status: 200, headers: { get: (k) => (k === "docker-content-digest" ? knobs.registryDigest ?? `sha256:${"a".repeat(64)}` : null) } });
  return { readers, getJson, fetchImpl, calls, head, lo, now: () => T0 + head * 1000 + 60_000 };
}
