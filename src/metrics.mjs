// Pure metric builders. Input: one "bundle" of raw readings collected by scan.mjs (chain at the
// low and high ends of the read window, explorer responses, cached history). Output: metric
// records in the v1 schema. No I/O here, so every rule is testable from a recorded bundle.
//
// Window: `lo` is the block the explorer said it had indexed when we started reading it; `hi` is
// the chain head after we finished. Explorer numbers are read somewhere inside [lo, hi].

import { STATUS, reading, reconcileBracketed, reconcileExact, reconcileRows, worst } from "./reconcile.mjs";
import { reconcileRewards } from "./rewards.mjs";
import { documentedLeg } from "./schedule.mjs";
import { explorerLink } from "./sources/explorer.mjs";

const VERIFIER_LABEL = {
  settlementSp1Pallet: "SP1", settlementGroth16Pallet: "Groth16", settlementRisc0Pallet: "RISC Zero", settlementPlonky2Pallet: "Plonky2",
  settlementFFlonkPallet: "FFlonk", settlementUltraplonkPallet: "UltraPlonk", settlementUltrahonkPallet: "UltraHonk", settlementEzklPallet: "EZKL",
  settlementTeePallet: "TEE",
};

/** An integer reading as a string, or null when absent or malformed (a malformed source is an unread one). */
export const n = (v) => {
  if (typeof v === "bigint") return v.toString();
  if (typeof v === "number") return Number.isSafeInteger(v) ? String(v) : null;
  if (typeof v === "string" && /^-?\d+$/.test(v)) return v;
  return null;
};
const B = (x) => BigInt(n(x) ?? 0);
const sumBig = (xs) => xs.reduce((a, x) => a + BigInt(n(x) ?? 0), 0n);
const at = (end, b) => (b && end ? { block: end.number, hash: end.hash } : {});

const absBig = (x) => (x < 0n ? -x : x);

/** Explorer reading equal to the chain at either end of the window (for values that move both ways). */
export function equalsEither(lo, hi, observed) {
  const readings = [lo, hi, observed];
  const chain = [lo, hi].filter((r) => r.value !== null);
  if (observed.value === null || chain.length === 0) return { status: STATUS.PENDING, value: null, delta: null, readings };
  if (chain.some((r) => r.value === observed.value)) return { status: STATUS.MATCH, value: observed.value, delta: null, readings };
  const deltas = chain.map((r) => absBig(BigInt(r.value) - BigInt(observed.value)));
  return { status: STATUS.MISMATCH, value: null, delta: String(deltas.reduce((a, b) => (b < a ? b : a))), readings };
}

function metric(base, result, extra = {}) {
  return { ...base, status: result.status, value: result.value ?? null, method: result.method, delta: result.delta ?? null, readings: result.readings, ...extra };
}

function chainPair(bundle, path, label) {
  const get = (end) => path.split(".").reduce((o, k) => (o == null ? null : o[k]), bundle.chain?.[end]?.counters);
  const lo = bundle.window?.lo;
  const hi = bundle.window?.hi;
  return [
    reading("rpc.storage", n(get("lo")), { label: `${label} at the window start`, ...at(lo, true) }),
    reading("rpc.storage", n(get("hi")), { label: `${label} at the window end`, ...at(hi, true) }),
  ];
}

/** Counter on chain vs the explorer's figure read inside the window. */
function bracketMetric(bundle, base, path, label, explorerValue, explorerLabel, extraReadings = []) {
  const [lo, hi] = chainPair(bundle, path, label);
  const ex = reading("explorer", n(explorerValue), { label: explorerLabel });
  const r = reconcileBracketed(lo, hi, ex);
  return metric(base, { ...r, readings: [...r.readings, ...extraReadings] });
}

// ---------------------------------------------------------------- rewards

function rewardsMetrics(bundle) {
  const out = [];
  const rw = bundle.chain?.rewards;
  const ex = bundle.explorer ?? {};
  const base = { group: "rewards", unit: "FLOP" };
  let rec = null;
  if (rw?.state && rw?.periods) rec = reconcileRewards(rw.state, rw.periods);
  const pin = rw?.state?.pinned;
  const internal = rec ? (rec.ok ? "events = counters, every period read" : `events vs counters: ${rec.mismatches.length} mismatches`) : "not read";
  const ev = (v, label) => reading("rpc.events", rec ? n(v) : null, { label, block: pin?.number, hash: pin?.hash });
  const ctr = (v, label) => reading("rpc.storage", rec && rec.ok ? n(v) : null, { label, block: pin?.number, hash: pin?.hash });
  const sched = rec ? rec.totals.scheduled : null;
  const minerLeg = rec ? String(rec.rows.reduce((a, r) => a + documentedLeg(BigInt(r.scheduled), "miner"), 0n)) : null;

  out.push(metric({ ...base, id: "rewards.scheduled", title: "Block rewards scheduled", note: "Sum of each period's pot. Recomputed from runtime constants, read from RewardsDistributed.total_reward, and the explorer's totalDistributed." },
    reconcileExact([
      reading("schedule", sched, { label: "initialRewardPerBlock >> halvings, summed per period" }),
      ev(rec ? sumBig(rw.periods.map((p) => p.distributed?.total_reward ?? 0)) : null, "sum of RewardsDistributed.total_reward"),
      reading("explorer", n(ex.rewardsSummary?.totalDistributed), { label: "/api/rewards/summary totalDistributed" }),
    ])));

  const legs = rec?.totals ?? {};
  const minerCounter = rw?.state?.counters?.miner;
  out.push(metric({ ...base, id: "rewards.miner_minted", title: "Miner leg minted", note: `Of ${minerLeg ? "the scheduled miner leg (75% of each pot)" : "the miner leg"}. The runtime mints a period's miner leg only for miners with verified G_n.`, context: { scheduled_miner_leg: minerLeg } },
    reconcileExact([
      ev(legs.miner, "sum of RewardsDistributed.miner_share"),
      ctr(minerCounter, "blockRewards.totalMinerRewards"),
      reading("explorer", n(ex.rewardsSummary?.totalMinerRewards), { label: "/api/rewards/summary totalMinerRewards" }),
    ])));
  out.push(metric({ ...base, id: "rewards.validator_minted", title: "Validator leg minted" },
    reconcileExact([
      ev(legs.validator, "sum of RewardsDistributed.validator_share"),
      ctr(rw?.state?.counters?.validator, "blockRewards.totalValidatorRewards"),
      reading("explorer", n(ex.rewardsSummary?.totalValidatorRewards), { label: "/api/rewards/summary totalValidatorRewards" }),
    ])));
  out.push(metric({ ...base, unit: "count", id: "rewards.periods", title: "Reward periods distributed" },
    reconcileExact([
      ev(rec ? rec.periods : null, "periods with a RewardsDistributed event"),
      reading("explorer", n(ex.rewardsSummary?.distributionCount), { label: "/api/rewards/summary distributionCount" }),
    ])));
  const exPaid = Array.isArray(ex.rewardDistributions) ? ex.rewardDistributions.filter((d) => Number(d.miners_paid) > 0).length : null;
  out.push(metric({ ...base, unit: "count", id: "rewards.periods_with_miner_payout", title: "Periods with a miner payout" },
    reconcileExact([
      ev(rec ? rec.periods_with_miners_paid : null, "periods whose RewardsDistributed.miners_paid > 0"),
      reading("explorer", n(exPaid), { label: "/api/rewards/distributions rows with miners_paid > 0" }),
    ])));

  // Row by row: every period on chain vs the explorer's distribution row.
  if (rec && Array.isArray(ex.rewardDistributions)) {
    const left = new Map(rw.periods.filter((p) => p.distributed).map((p) => [p.block, { total: p.distributed.total_reward, miner: p.distributed.miner_share, validator: p.distributed.validator_share, miners_paid: String(p.distributed.miners_paid) }]));
    const right = new Map(ex.rewardDistributions.map((d) => [String(d.block_number), { total: String(d.total_reward), miner: String(d.miner_share), validator: String(d.validator_share), miners_paid: String(d.miners_paid) }]));
    const rows = reconcileRows(left, right, { leftName: "chain", rightName: "explorer" });
    out.push({ ...base, unit: "count", id: "rewards.period_rows", title: "Reward periods, row by row", status: rows.status, value: rows.status === STATUS.MATCH ? String(rows.agreed) : null, method: "rowwise", delta: rows.disagreed ? String(rows.disagreed) : null,
      readings: [reading("rpc.events", String(left.size), { label: "periods read from chain events" }), reading("explorer", String(right.size), { label: "rows in /api/rewards/distributions" })],
      detail: { checked: rows.checked, agreed: rows.agreed, disagreements: rows.disagreements }, note: internal });
  }
  if (rec) {
    out.push({ group: "rewards", id: "rewards.period_table", kind: "table", title: "Reward periods", status: rec.ok ? STATUS.MATCH : STATUS.MISMATCH,
      columns: ["block", "scheduled", "miner_share", "miner_leg_unminted", "miners_paid"],
      rows: rec.rows.map((r) => ({ ...r, link: explorerLink.block(r.block) })), findings: rec.findings, mismatches: rec.mismatches });
  }
  return out;
}

// ---------------------------------------------------------------- miners

function minerMetrics(bundle) {
  const out = [];
  const c = bundle.chain ?? {};
  const ex = bundle.explorer ?? {};
  const base = { group: "miners" };
  out.push(bracketMetric(bundle, { ...base, unit: "count", id: "miners.registered", title: "Registered miners" }, "miners.total_miners", "minerStaking.totalMiners",
    ex.stats?.registeredMiners, "/api/stats registeredMiners",
    [reading("rpc.keys", n(c.hi?.keys?.miners), { label: "minerStaking.miners map size", ...at(bundle.window?.hi, true) }),
      reading("explorer", n(ex.totals?.miners), { label: "/api/miners pagination.total (includes retired)", context: true })]));

  // Per-miner rewards: chain minerStaking.totalRewardsEarned vs explorer totalRewards vs blockRewards events.
  const chainMiners = c.hi?.minerTables?.miners ?? null;
  const exMiners = Array.isArray(ex.miners) ? ex.miners : null;
  const eventSums = new Map();
  for (const p of c.rewards?.periods ?? []) for (const r of p.miner_rewards ?? []) eventSums.set(r.miner, (eventSums.get(r.miner) ?? 0n) + B(r.amount));
  if (chainMiners && exMiners) {
    const left = new Map();
    const right = new Map();
    const ids = new Set([...Object.keys(chainMiners).filter((a) => chainMiners[a].total_rewards_earned !== "0"), ...exMiners.filter((m) => String(m.totalRewards) !== "0").map((m) => m.address), ...eventSums.keys()]);
    const exBy = new Map(exMiners.map((m) => [m.address, m]));
    const rows = [];
    for (const a of ids) {
      const chainV = chainMiners[a]?.total_rewards_earned ?? "0";
      const exV = exBy.has(a) ? n(exBy.get(a).totalRewards) : "0";
      const evV = String(eventSums.get(a) ?? 0n);
      left.set(a, { earned: chainV });
      right.set(a, { earned: exV });
      const r = reconcileExact([reading("rpc.storage", chainV), reading("explorer", exV), reading("rpc.events", evV)]);
      rows.push({ miner: a, rpc_storage: chainV, explorer: exV, rpc_events: evV, status: r.status, link: explorerLink.account(a) });
    }
    rows.sort((x, y) => (B(y.rpc_events) > B(x.rpc_events) ? 1 : B(y.rpc_events) < B(x.rpc_events) ? -1 : 0));
    const st = worst(rows.map((r) => r.status));
    out.push({ ...base, unit: "FLOP", id: "miners.rewards_total", title: "Rewards earned by miners", ...metric({}, reconcileExact([
      reading("rpc.storage", String(sumBig(rows.map((r) => r.rpc_storage)))), reading("explorer", String(sumBig(rows.map((r) => r.explorer)))), reading("rpc.events", String(sumBig(rows.map((r) => r.rpc_events))), { label: "MinerRewarded events in reward periods" }),
    ])), note: "minerStaking.totalRewardsEarned vs explorer totalRewards vs blockRewards.MinerRewarded, summed over miners that earned anything." });
    out.push({ ...base, id: "miners.rewards_table", kind: "table", title: "Miners with rewards", status: st, columns: ["miner", "rpc_storage", "rpc_events", "explorer", "status"], rows });
  } else {
    out.push(metric({ ...base, unit: "FLOP", id: "miners.rewards_total", title: "Rewards earned by miners" }, reconcileExact([reading("rpc.storage", null), reading("explorer", null)])));
  }

  // Liveness: ghost (synthetic) tasks issued vs completed. A proxy for uptime, not a measurement of it.
  const gLo = c.lo?.ghost ?? null;
  const gHi = c.hi?.minerTables?.ghost ?? null;
  const rel = Array.isArray(ex.reliability) ? ex.reliability : null;
  const totals = (tbl, f) => (tbl ? String(sumBig(Object.values(tbl).map((g) => g[f]))) : null);
  for (const f of ["issued", "completed"]) {
    const exSum = rel ? String(sumBig(rel.map((r) => r.ghost?.[f] ?? 0))) : null;
    const r = reconcileBracketed(reading("rpc.storage", totals(gLo, f), { label: `sum of MinerGhostStatsStore.total_${f} at window start`, ...at(bundle.window?.lo, true) }),
      reading("rpc.storage", totals(gHi, f), { label: `sum of MinerGhostStatsStore.total_${f} at window end`, ...at(bundle.window?.hi, true) }),
      reading("explorer", exSum, { label: `sum of /api/miner-reliability ghost.${f}` }));
    out.push(metric({ ...base, unit: "count", id: `miners.ghost_${f}`, title: f === "issued" ? "Liveness probes issued" : "Liveness probes completed",
      note: "Synthetic (ghost) tasks the runtime sends miners to check they answer. Global counters syntheticTasks.total* are shown for context; they also count tasks for miners that have since left." },
    { ...r, readings: [...r.readings, reading("rpc.storage", n(c.hi?.counters?.ghost?.[f]), { label: `syntheticTasks.total${f[0].toUpperCase()}${f.slice(1)}`, context: true, ...at(bundle.window?.hi, true) })] }));
  }
  if (gLo && gHi && rel) {
    const rows = [];
    for (const r of rel) {
      const a = r.miner;
      const lo = gLo[a];
      const hi = gHi[a];
      const fields = ["issued", "completed", "expired", "incorrect"];
      const ok = lo && hi && fields.every((f) => {
        if (n(r.ghost?.[f]) === null) return false;
        const x = B(r.ghost[f]); const p = B(lo[f]); const q = B(hi[f]);
        return (p <= x && x <= q) || (q <= x && x <= p);
      });
      const issued = B(r.ghost?.issued);
      const completed = B(r.ghost?.completed);
      rows.push({ miner: a, issued: String(issued), completed: String(completed), expired: String(B(r.ghost?.expired)),
        completion_bps: issued > 0n ? String((completed * 10_000n) / issued) : null, chain_issued: hi?.issued ?? null, chain_completed: hi?.completed ?? null,
        status: ok ? STATUS.MATCH : STATUS.MISMATCH, link: explorerLink.account(a) });
    }
    rows.sort((x, y) => (B(y.issued) > B(x.issued) ? 1 : B(y.issued) < B(x.issued) ? -1 : 0));
    const agreed = rows.filter((r) => r.status === STATUS.MATCH).length;
    out.push({ ...base, id: "miners.liveness_table", kind: "table", title: "Liveness by miner", status: agreed === rows.length ? STATUS.MATCH : STATUS.MISMATCH,
      summary: { checked: rows.length, agreed, chain_only: Object.keys(gHi).filter((a) => !rel.some((r) => r.miner === a)).length },
      columns: ["miner", "issued", "completed", "completion_bps", "status"], rows: rows.slice(0, 50) });
  }
  return out;
}

// ---------------------------------------------------------------- compute (sessions and settlement)

function computeMetrics(bundle) {
  const out = [];
  const c = bundle.chain ?? {};
  const ex = bundle.explorer ?? {};
  const s = bundle.settlements ?? null; // { lo: {miner_paid, burned, rows}, hi: {...}, cursor } from the cached explorer rows
  const base = { group: "compute" };
  const lo = bundle.window?.lo;
  const hi = bundle.window?.hi;
  // Miner paid: chain counter at lo and at hi, vs explorer rows summed up to exactly those blocks.
  const loR = reconcileExact([
    reading("rpc.storage", n(c.lo?.counters?.compute?.miner_paid), { label: "computeChannel.totalMinerPaid", ...at(lo, true) }),
    reading("explorer", s ? n(s.lo?.miner_paid) : null, { label: `sum of /api/settlement-prices minerPaid, settledBlock <= ${lo?.number}` }),
  ]);
  const hiR = reconcileExact([
    reading("rpc.storage", n(c.hi?.counters?.compute?.miner_paid), { label: "computeChannel.totalMinerPaid", ...at(hi, true) }),
    reading("explorer", s ? n(s.hi?.miner_paid) : null, { label: `sum of /api/settlement-prices minerPaid, settledBlock <= ${hi?.number}` }),
  ]);
  const st = worst([loR.status, hiR.status]);
  out.push({ ...base, unit: "FLOP", id: "compute.miner_paid", title: "Compute settled to miners", status: st,
    value: st === STATUS.MATCH ? hiR.value : null, method: "exact at both window ends", delta: hiR.delta ?? loR.delta ?? null,
    readings: [...loR.readings, ...hiR.readings, reading("explorer", n(ex.inferenceSpend?.totalSpentRaw), { label: "/api/inference-spend totalSpentRaw", context: true })],
    note: "FLOP paid to miners for inference, cumulative. Each settlement row is also rechecked against the Settled event in its block (see sampled rows)." });

  out.push(metric({ ...base, unit: "count", id: "compute.settlements", title: "Settlements" }, reconcileBracketed(
    reading("explorer", s ? n(s.lo?.rows) : null, { label: `settlement rows, settledBlock <= ${lo?.number}` }),
    reading("explorer", s ? n(s.hi?.rows) : null, { label: `settlement rows, settledBlock <= ${hi?.number}` }),
    reading("explorer", n(ex.inferenceSpend?.settledChannels), { label: "/api/inference-spend settledChannels" }),
  ), { note: "Two explorer endpoints (row list and aggregate), one indexer: this is a consistency check, not an independent source. Each row's amounts are checked on chain in compute.settlement_rows.", single_indexer: true }));

  if (bundle.settlementChecks) {
    const ck = bundle.settlementChecks;
    const checked = n(ck.checked);
    const agreed = n(ck.agreed);
    const disagreed = n(ck.disagreed);
    const ok = checked !== null && agreed !== null && disagreed !== null && BigInt(checked) === BigInt(agreed) + BigInt(disagreed);
    const status = !ok || checked === "0" ? STATUS.PENDING : disagreed === "0" ? STATUS.MATCH : STATUS.MISMATCH;
    out.push({ ...base, unit: "count", id: "compute.settlement_rows", title: "Settlement rows checked on chain", status,
      value: status === STATUS.MATCH ? agreed : null, method: "rowwise", delta: status === STATUS.MISMATCH ? disagreed : null,
      readings: [reading("explorer", checked, { label: "newest settlement rows sampled this run" }), reading("rpc.events", agreed, { label: "rows whose computeChannel.Settled event has the same channel, miner_paid, burned and aggregate_gn" })],
      detail: { disagreements: Array.isArray(ck.disagreements) ? ck.disagreements.slice(0, 20) : [] } });
  }

  out.push(metric({ ...base, unit: "count", id: "compute.channels", title: "Compute channels" }, reconcileExact([
    reading("rpc.keys", n(c.hi?.keys?.channels), { label: "computeChannel.channels map size", ...at(hi, true) }),
    reading("explorer", n(ex.totals?.channels), { label: "/api/compute-channels pagination.total" }),
  ]), { note: "Channels opened and still in storage. A gap means one side counts channels the other does not (pruned, pending, or not yet indexed)." }));

  out.push(bracketMetric(bundle, { ...base, unit: "count", id: "compute.session_keys", title: "Agent session keys" }, "sessions.total_sessions", "flopSessionKeys.totalSessions",
    ex.totals?.sessions, "/api/sessions pagination.total"));
  return out;
}

// ---------------------------------------------------------------- verifiers

function verifierMetrics(bundle) {
  const out = [];
  const v = bundle.chain?.verifiers;
  const checks = bundle.verifierChecks; // { [pallet]: { explorer: k, confirmed: k, txs:[...] } }
  const base = { group: "verifiers", unit: "count" };
  const rows = [];
  for (const pallet of Object.keys(VERIFIER_LABEL)) {
    const chainRow = v?.rows?.find((r) => r.pallet === pallet) ?? null;
    const ck = checks?.[pallet] ?? null;
    const r = reconcileExact([
      reading("explorer", ck ? n(ck.explorer) : null, { label: `ProofVerified events in /api/transactions?section=${pallet}` }),
      reading("rpc.events", ck ? n(ck.confirmed) : null, { label: "of those, found in the block's events on chain" }),
    ]);
    rows.push({ pallet, label: VERIFIER_LABEL[pallet], present: chainRow?.present ?? null, vks: chainRow?.vks ?? null, tickets: chainRow?.tickets ?? null,
      proofs_verified: r.value, status: r.status, txs: (ck?.txs ?? []).map((t) => ({ ...t, link: explorerLink.tx(t.hash) })) });
    out.push(metric({ ...base, id: `verifiers.${pallet}`, title: `${VERIFIER_LABEL[pallet]} proofs verified` }, r,
      { context: chainRow ? { vks: chainRow.vks, tickets: chainRow.tickets, present: chainRow.present } : null }));
  }
  out.push({ group: "verifiers", id: "verifiers.table", kind: "table", title: "Proof verifiers", status: worst(rows.map((r) => r.status)), columns: ["label", "proofs_verified", "vks", "tickets", "status"], rows,
    blind_spots: ["Only top-level calls are counted. A proof submitted inside utility.batch, proxy.proxy, sudo or multisig is indexed under that wrapper's section, so it is missed by both sides of this check.", "Tickets and vks are storage sizes at the window end, shown for context."] });
  return out;
}

// ---------------------------------------------------------------- forward market

function forwardMetrics(bundle) {
  const k = bundle.chain?.hi?.keys ?? null;
  const f = bundle.chain?.hi?.counters?.forward ?? null;
  const ex = bundle.explorer ?? {};
  const s = bundle.settlements;
  const chainActive = k && f ? sumBig([k.funded_forward_offers, k.forward_positions, k.forward_bids, k.forward_listings]) + B(f.bond_locked) + B(f.bond_released) + B(f.bond_slashed) : null;
  const trades = Array.isArray(ex.termCurve?.history) ? sumBig(ex.termCurve.history.map((h) => h?.tradeCount ?? 0)) : null;
  const exActive = s && trades !== null ? B(s.forward_rows) + trades : null;
  const r = reconcileExact([
    reading("rpc.storage", chainActive === null ? null : chainActive === 0n ? "none" : "some", { label: "forward offers + positions + bids + listings + bond totals" }),
    reading("explorer", exActive === null ? null : exActive === 0n ? "none" : "some", { label: "forward settlement rows + /api/term-curve trades" }),
  ]);
  return [metric({ group: "forward", unit: "text", id: "forward.activity", title: "Forward compute market activity" }, r, {
    note: "The two sides count different things, so only presence is compared: both see no forward activity, or both see some.",
    context: { chain: k && f ? { funded_offers: k.funded_forward_offers, positions: k.forward_positions, bids: k.forward_bids, listings: k.forward_listings, ...f } : null,
      explorer: { forward_settlement_rows: s?.forward_rows ?? null, term_curve_trades: trades === null ? null : String(trades), term_curve_days: ex.termCurve?.days ?? null, methodology: ex.termCurve?.methodologyVersion ?? null } },
  })];
}

// ---------------------------------------------------------------- agents

function agentMetrics(bundle) {
  const c = bundle.chain ?? {};
  const ex = bundle.explorer ?? {};
  const hi = bundle.window?.hi;
  return [
    metric({ group: "agents", unit: "count", id: "agents.identities", title: "Agent identities registered",
      note: "Three readings of one source (the chain): the counter, the map size and the global stats. The explorer has no identity count to compare.", single_source: true },
    reconcileExact([
      reading("rpc.storage", n(c.hi?.counters?.agents?.agent_count), { label: "agentIdentity.agentCount", ...at(hi, true) }),
      reading("rpc.keys", n(c.hi?.keys?.agents), { label: "agentIdentity.agents map size", ...at(hi, true) }),
      reading("rpc.storage", n(c.hi?.counters?.agents?.global_total_agents), { label: "agentIdentity.globalStats.totalAgents", ...at(hi, true) }),
    ])),
    bracketMetric(bundle, { group: "agents", unit: "count", id: "agents.wallets", title: "Agent wallets" }, "wallets.total_wallets", "agentWallet.totalWallets",
      ex.totals?.agent_wallets, "/api/agent-wallets pagination.total", [reading("explorer", n(ex.stats?.activeAgents), { label: "/api/stats activeAgents", context: true })]),
  ];
}

// ---------------------------------------------------------------- faucet

function faucetMetrics(bundle) {
  const out = [];
  const f = bundle.faucet;
  const base = { group: "faucet" };
  if (!f?.signer) {
    out.push(metric({ ...base, unit: "FLOP", id: "faucet.balance", title: "Faucet balance" }, reconcileExact([reading("rpc.storage", null), reading("explorer", null)])));
    return out;
  }
  const lo = bundle.window?.lo;
  const hi = bundle.window?.hi;
  const chainLo = reading("rpc.storage", n(f.chain_lo?.free), { label: "system.account.free", ...at(lo, true) });
  const chainHi = reading("rpc.storage", n(f.chain_hi?.free), { label: "system.account.free", ...at(hi, true) });
  const exR = reading("explorer", n(f.explorer?.balance), { label: `/api/accounts/${f.signer} balance` });
  // The faucet spends all the time, so the explorer's balance must equal the chain at one of the two ends.
  const balR = equalsEither(chainLo, chainHi, exR);
  balR.method = "exact at either window end";
  balR.readings = [...balR.readings, reading("faucet-service", f.service?.balanceFlop == null ? null : String(f.service.balanceFlop), { label: "faucet /limits balanceFlop (whole FLOP, about a minute stale)", context: true })];
  out.push(metric({ ...base, unit: "FLOP", id: "faucet.balance", title: "Faucet balance", link: explorerLink.account(f.signer), context: { signer: f.signer } }, balR));
  out.push(metric({ ...base, unit: "count", id: "faucet.transactions", title: "Faucet transactions sent", link: explorerLink.account(f.signer), note: "The signer's nonce on chain vs the explorer's transaction count for the same account." },
    reconcileBracketed(reading("rpc.storage", n(f.chain_lo?.nonce), { label: "system.account.nonce", ...at(lo, true) }), reading("rpc.storage", n(f.chain_hi?.nonce), { label: "system.account.nonce", ...at(hi, true) }),
      reading("explorer", n(f.explorer?.txCount), { label: `/api/accounts/${f.signer} txCount` }))));
  // Flow over the last ~24 h, from our own history of earlier runs.
  const flow = bundle.faucetFlow;
  if (flow) {
    const note = `From block ${flow.from_block} to ${flow.to_block} (${flow.hours} h), from this scanner's history of earlier runs. The chain gives a range (each run read both ends of its window); the explorer's figure must fall inside it.`;
    out.push(metric({ ...base, unit: "count", id: "faucet.transactions_window", title: "Faucet transactions in the window", note, window: flow },
      reconcileBracketed(reading("rpc.storage", n(flow.chain_tx_range?.[0]), { label: "nonce change, low end" }), reading("rpc.storage", n(flow.chain_tx_range?.[1]), { label: "nonce change, high end" }), reading("explorer", n(flow.explorer_tx_delta), { label: "txCount change" }))));
    out.push(metric({ ...base, unit: "FLOP", id: "faucet.outflow_window", title: "Faucet net outflow in the window", note, window: flow },
      reconcileBracketed(reading("rpc.storage", n(flow.chain_outflow_range?.[0]), { label: "balance decrease, low end" }), reading("rpc.storage", n(flow.chain_outflow_range?.[1]), { label: "balance decrease, high end" }), reading("explorer", n(flow.explorer_outflow), { label: "explorer balance decrease" }))));
  } else {
    out.push(metric({ ...base, unit: "count", id: "faucet.transactions_window", title: "Faucet transactions in the window", note: "Needs two runs of history." }, reconcileExact([reading("rpc.storage", null), reading("explorer", null)])));
  }
  return out;
}

// ---------------------------------------------------------------- supply, validators

function supplyMetrics(bundle) {
  const ex = bundle.explorer ?? {};
  return [
    bracketMetric(bundle, { group: "supply", unit: "FLOP", id: "supply.total_issuance", title: "Total issuance" }, "supply.total_issuance", "balances.totalIssuance", ex.stats?.totalSupply, "/api/stats totalSupply"),
    bracketMetric(bundle, { group: "supply", unit: "count", id: "validators.active", title: "Active validators" }, "validators.session_validators", "session.validators length", ex.stats?.activeValidators, "/api/stats activeValidators"),
  ];
}

// ---------------------------------------------------------------- runtime and releases

function versionMetrics(bundle) {
  const out = [];
  const rt = bundle.runtime; // { spans: [{spec_version, from_block, to_block, event: {block, found}}], current }
  const lastUpgrade = bundle.chain?.hi?.counters?.runtime ?? null;
  if (rt?.spans?.length) {
    const cur = rt.spans[rt.spans.length - 1];
    out.push(metric({ group: "versions", unit: "text", id: "runtime.current", title: "Runtime version", note: "state_getRuntimeVersion at the window end vs system.lastRuntimeUpgrade." },
      reconcileExact([reading("rpc.runtime", `${cur.spec_name} ${cur.spec_version}`, { label: "state_getRuntimeVersion" }),
        reading("rpc.storage", lastUpgrade ? `${lastUpgrade.spec_name} ${lastUpgrade.spec_version}` : null, { label: "system.lastRuntimeUpgrade" })])));
    const upgrades = rt.spans.slice(1);
    const confirmed = upgrades.filter((s) => s.code_updated_block != null).length;
    out.push(metric({ group: "versions", unit: "count", id: "runtime.upgrades", title: "Runtime upgrades found", note: "Boundaries found by bisecting state_getRuntimeVersion over block numbers; each must have a system.CodeUpdated event in the boundary block or the one before. Bisection cannot see an upgrade that was reverted to the same version between two probes." },
      reconcileExact([reading("rpc.runtime", String(upgrades.length), { label: "version boundaries by bisection" }), reading("rpc.events", String(confirmed), { label: "boundaries with a CodeUpdated event" })])));
    out.push({ group: "versions", id: "runtime.table", kind: "table", title: "Runtime history", status: confirmed === upgrades.length ? STATUS.MATCH : STATUS.MISMATCH,
      columns: ["spec_version", "from_block", "to_block", "code_updated_block"], rows: rt.spans.map((s) => ({ ...s, link: explorerLink.block(s.from_block) })) });
  } else {
    out.push(metric({ group: "versions", unit: "text", id: "runtime.current", title: "Runtime version" }, reconcileExact([reading("rpc.runtime", null), reading("rpc.storage", lastUpgrade ? `${lastUpgrade.spec_name} ${lastUpgrade.spec_version}` : null)])));
  }
  const rel = bundle.releases; // [{component, version, explorer_digest, registry_digest, image}]
  if (Array.isArray(rel)) {
    const digest = (d) => (typeof d === "string" && /^sha256:[0-9a-f]{64}$/.test(d) ? d : null);
    for (const r0 of rel) {
      if (!r0 || typeof r0.component !== "string" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(r0.component)) continue;
      const r = { ...r0, version: typeof r0.version === "string" && /^[0-9A-Za-z._-]{1,40}$/.test(r0.version) ? r0.version : "unknown", explorer_digest: digest(r0.explorer_digest), registry_digest: digest(r0.registry_digest) };
      out.push(metric({ group: "versions", unit: "text", id: `release.${r.component}`, title: `${r.component} release`, context: { version: r.version, minimum: r.minimum ?? null, image: r.image } },
        reconcileExact([reading("explorer", r.explorer_digest, { label: `/api/operator-releases ${r.component} (v${r.version})` }), reading("ghcr", r.registry_digest, { label: `ghcr.io manifest for tag v${r.version}` })]),
        { display: `v${r.version}` }));
    }
  }
  if (Array.isArray(bundle.releaseHistory)) {
    out.push({ group: "versions", id: "release.history", kind: "table", title: "Release history seen by this scanner", status: STATUS.MATCH, columns: ["component", "version", "first_seen_block", "first_seen_utc"], rows: bundle.releaseHistory, note: "Recorded by this scanner since it went live; a version is added only after its digest matched on both sides." });
  }
  return out;
}

const BUILDERS = [
  ["rewards", rewardsMetrics], ["miners", minerMetrics], ["compute", computeMetrics], ["verifiers", verifierMetrics],
  ["forward", forwardMetrics], ["agents", agentMetrics], ["faucet", faucetMetrics], ["supply", supplyMetrics], ["versions", versionMetrics],
];

/** Every metric. A builder that fails on malformed input yields one pending record, never a crash or a number. */
export function buildMetrics(bundle) {
  const out = [];
  for (const [group, build] of BUILDERS) {
    try { out.push(...build(bundle ?? {})); } catch (e) {
      out.push({ group, id: `${group}.unavailable`, title: `${group} metrics`, unit: "text", status: STATUS.PENDING, value: null, method: "none", delta: null, readings: [], note: `Could not be built from this run's readings: ${String(e?.message ?? e).slice(0, 200)}` });
    }
  }
  return out;
}

/** Keep the last agreed value next to a metric that has none this run, labelled with its block. */
export function carryLastMatch(metrics, previous, asOf) {
  const prev = new Map((previous ?? []).map((m) => [m.id, m]));
  return metrics.map((m) => {
    if (m.kind === "table") return m;
    if (m.status === STATUS.MATCH && m.value !== null) return { ...m, last_match: { value: m.value, block: asOf?.block ?? null, time_utc: asOf?.time_utc ?? null } };
    const p = prev.get(m.id);
    return p?.last_match ? { ...m, last_match: p.last_match } : m;
  });
}
