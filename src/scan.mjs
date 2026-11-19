// One incremental, resumable scan: read the explorer, pin the chain to the explorer's indexed
// block and to the chain head after, reconcile, and write versioned JSON.
//
// Resumable: every expensive unit (reward periods, runtime probes, settlement pages, verifier
// checks) is saved to the cache before the next starts, so a crashed run picks up where it died.
// Every source failure is recorded and turns the affected metrics `pending`, never into a number.

import { join } from "node:path";
import { connect, readPeriod, readRewardsState, readVerifiers } from "./chain.mjs";
import { buildMetrics, carryLastMatch } from "./metrics.mjs";
import { createJsonGetter, createLimiter } from "./polite.mjs";
import { extendRuntimeHistory } from "./runtime.mjs";
import { mergeRows, REFETCH_MARGIN_BLOCKS, settledMatches, totalsUpTo } from "./settlements.mjs";
import { periodBoundaries } from "./schedule.mjs";
import { createExplorer } from "./sources/explorer.mjs";
import { faucetWindow, walkSignerTxs } from "./faucet.mjs";
import * as rpc from "./sources/rpc.mjs";
import { createStore, readJson, writeJsonAtomic } from "./store.mjs";
import { STATUS } from "./reconcile.mjs";

export const SCHEMA_ID = "https://xbtmelchizedek.github.io/flopscan/schema/v1.json";
export const SCHEMA_VERSION = "1.0.0";
export const FAUCET = "https://faucet.flop.network";
const GHCR = "https://ghcr.io";
const SETTLEMENT_SAMPLE = 8;
const AGENT_SAMPLE = 8;
const HISTORY_KEEP = 7 * 48; // a week of half-hourly runs
const DISCLAIMER = "Devnet data, not financial information. Unaudited. Devnet FLOP has no value.";

const iso = (ms) => (ms == null ? null : new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z"));

/** A crash hook for the resume test: throws once `n` units have been saved. */
export function crashAfter(n) {
  let left = n;
  return () => { if (left !== null && --left < 0) throw new Error("simulated crash"); };
}

/** The chain reads a scan needs, over a connected @polkadot/api. Tests pass a fake with the same shape. */
export function apiReaders(api) {
  return {
    head: async () => (await api.rpc.chain.getHeader()).hash.toHex(),
    blockAt: (hash) => rpc.blockAt(api, hash),
    counters: (hash) => rpc.readCounters(api, hash),
    keys: (hash) => rpc.readKeyCounts(api, hash),
    minerTables: (hash, opts) => rpc.readMinerTables(api, hash, opts),
    account: (hash, addr) => rpc.readAccount(api, hash, addr),
    verifiers: (pin) => readVerifiers(api, pin),
    rewardsState: (pin) => readRewardsState(api, pin),
    period: (b) => readPeriod(api, b),
    specAt: (b) => rpc.specAt(api, b),
    blockEvents: (x) => rpc.readBlockEvents(api, x),
    agents: (hash, seed, k) => rpc.sampleAgents(api, hash, seed, k),
    disconnect: () => api.disconnect(),
  };
}

export async function scan({ outDir, cacheDir, network = "devnet", rpcUrl, explorerBase, getJson, connectChain, now = () => Date.now(), log = () => {}, onUnit = () => {}, fetchImpl = globalThis.fetch, bundlePath = null } = {}) {
  const store = createStore(cacheDir);
  const errors = {};
  const note = (src, e) => { errors[src] = String(e?.message ?? e).slice(0, 300); log(`${src}: ${errors[src]}`); };
  const unit = (what) => { onUnit(what); };

  getJson ??= createJsonGetter({ limiter: createLimiter({ rps: 3, concurrency: 2 }), onRetry: (e, k, ms) => log(`http retry ${k + 1} in ${ms} ms: ${e.message}`) });
  const ex = createExplorer(getJson, explorerBase);
  const bundle = { chain: { lo: {}, hi: {} }, explorer: {}, window: {} };

  // 1. Explorer, bracketed by its own indexed head.
  log("phase explorer");
  let h1 = null;
  try { h1 = await ex.health(); } catch (e) { note("explorer", e); }
  if (h1) {
    const tryGet = async (key, fn) => { try { bundle.explorer[key] = await fn(); } catch (e) { note(`explorer.${key}`, e); } };
    await tryGet("stats", ex.stats);
    await tryGet("rewardsSummary", ex.rewardsSummary);
    await tryGet("rewardDistributions", ex.rewardDistributions);
    await tryGet("inferenceSpend", ex.inferenceSpend);
    await tryGet("totals", async () => ({
      agent_wallets: await ex.total("/api/agent-wallets"), sessions: await ex.total("/api/sessions"),
      channels: await ex.total("/api/compute-channels"), miners: await ex.total("/api/miners"),
    }));
    await tryGet("miners", async () => (await ex.miners()).map((m) => ({ address: m.address, totalRewards: String(m.totalRewards ?? "0"), isActive: Boolean(m.isActive) })));
    await tryGet("reliability", async () => (await ex.minerReliability()).map((r) => ({ miner: r.miner, ghost: r.ghost ?? {}, settledCount: r.settledCount ?? null, timeoutCount: r.timeoutCount ?? null })));
    await tryGet("termCurve", async () => { const t = await ex.termCurve(); return { methodologyVersion: t.methodologyVersion, days: t.days, history: (t.history ?? []).map((h) => ({ day: h.day, tenorDays: h.tenorDays, tradeCount: h.tradeCount ?? 0, publishable: Boolean(h.publishable) })) }; });
    await tryGet("operatorReleases", ex.operatorReleases);
    await tryGet("sections", ex.sections);
    // Settlements, incrementally from the cached cursor.
    try {
      // Pages are saved as they arrive; the cursor moves only when the walk back reaches it. A
      // crash mid-walk resumes at the saved offset (inserts at the top only shift rows down, so
      // resuming there can re-read rows, never skip them; rows are deduped by id).
      let cache = store.get("settlements", { cursor: 0, rows: {}, backfill: null });
      const since = cache.backfill?.since ?? Math.max(0, cache.cursor - (cache.cursor ? REFETCH_MARGIN_BLOCKS : 0));
      const startOffset = cache.backfill?.next_offset ?? 0;
      const newest = [];
      let top = cache.backfill?.top ?? cache.cursor;
      await ex.settlementsSince(since, {
        startOffset,
        onPage: (rows, nextOffset) => {
          if (newest.length < SETTLEMENT_SAMPLE) newest.push(...rows.slice(0, SETTLEMENT_SAMPLE - newest.length));
          const merged = mergeRows({ cursor: 0, rows: cache.rows }, rows);
          top = Math.max(top, merged.cursor);
          cache = { cursor: cache.cursor, rows: merged.rows, backfill: { since, next_offset: nextOffset, top } };
          store.put("settlements", cache); unit(`settlements offset ${nextOffset}`);
        },
      });
      cache = { cursor: Math.max(cache.cursor, top), rows: cache.rows, backfill: null };
      store.put("settlements", cache); unit("settlements done");
      bundle.settlementsNewest = newest;
      bundle._settlementCache = cache;
    } catch (e) { note("explorer.settlements", e); }
    // Faucet signer comes from the faucet service; its balance and nonce are then read on both sides.
    try {
      const limits = await getJson(`${FAUCET}/limits`);
      const signer = limits?.faucet?.signer;
      if (typeof signer !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{46,48}$/.test(signer)) throw new Error("faucet /limits: no signer address");
      const acct = await ex.account(signer);
      // liveBalance false: the explorer does not track this account's balance, so its "0" is unread.
      const exBalance = acct?.liveBalance === false || acct?.balance == null ? null : String(acct.balance);
      bundle.faucet = { signer, service: { balanceFlop: limits.faucet.balanceFlop ?? null, asOf: limits.asOf ?? null }, explorer: { balance: exBalance, txCount: acct?.txCount ?? null } };
      const prevWin = store.get("faucet-window", null);
      if (prevWin) {
        try {
          bundle.faucetWalk = await walkSignerTxs((offset, limit) => ex.get(`/api/accounts/${encodeURIComponent(signer)}/transactions?limit=${limit}&offset=${offset}`), signer, prevWin.time_ms);
        } catch (e) { note("explorer.faucet_txs", e); }
      }
    } catch (e) { note("faucet", e); }
    // Verifier calls as the explorer indexed them (only sections that have any).
    try {
      const present = new Set((bundle.explorer.sections?.data ?? []).filter((s) => /^settlement.*Pallet$/.test(s.section) && s.count > 0).map((s) => s.section));
      const txs = {};
      for (const section of present) txs[section] = (await ex.sectionTxs(section)).map((t) => ({ hash: t.hash, blockHash: t.blockHash, method: t.method, success: t.success, timestamp: t.timestamp, verified: (t.events ?? []).some((e) => e.section === section && e.method === "ProofVerified") }));
      bundle.explorer.verifierTxs = txs;
    } catch (e) { note("explorer.verifiers", e); }
  }

  // 2. Chain.
  log("phase chain");
  let api = null; // a readers object, see apiReaders
  try { api = connectChain ? await connectChain() : apiReaders(await connect(network, rpcUrl, { log })); } catch (e) { note("rpc", e); }
  try {
    if (api) {
      bundle.window.hi = await api.blockAt(await api.head());
      if (h1) {
        try { bundle.window.lo = await api.blockAt(h1.hash); } catch (e) { note("rpc.window_lo", e); }
      }
      const ends = [["hi", bundle.window.hi], ["lo", bundle.window.lo]].filter(([, b]) => b);
      for (const [end, b] of ends) {
        try { bundle.chain[end].counters = await api.counters(b.hash); } catch (e) { note(`rpc.counters_${end}`, e); }
      }
      const hi = bundle.window.hi;
      log(`window ${bundle.window.lo?.number ?? "?"}..${hi.number}`);
      try { bundle.chain.hi.keys = await api.keys(hi.hash); } catch (e) { note("rpc.keys", e); }
      try { bundle.chain.hi.minerTables = await api.minerTables(hi.hash); } catch (e) { note("rpc.miners", e); }
      if (bundle.window.lo) { try { bundle.chain.lo.ghost = (await api.minerTables(bundle.window.lo.hash, { withMiners: false })).ghost; } catch (e) { note("rpc.ghost_lo", e); } }
      if (bundle.faucet) {
        for (const [end, b] of ends) { try { bundle.faucet[`chain_${end}`] = await api.account(b.hash, bundle.faucet.signer); } catch (e) { note(`rpc.faucet_${end}`, e); } }
      }
      try { bundle.chain.verifiers = await api.verifiers({ hash: hi.hash, number: hi.number }); } catch (e) { note("rpc.verifiers", e); }

      // Rewards: state at hi, periods from cache, new periods read and saved one by one.
      log("phase rewards");
      try {
        const state = await api.rewardsState({ hash: hi.hash, number: hi.number });
        const periods = store.get("reward-periods", {});
        for (const b of periodBoundaries(state.lastDistributionBlock, state.consts.distributionPeriodBlocks)) {
          if (periods[String(b)]) continue;
          periods[String(b)] = await api.period(Number(b));
          store.put("reward-periods", periods); unit(`period ${b}`);
        }
        bundle.chain.rewards = { state, periods: Object.values(periods).filter((p) => BigInt(p.block) <= BigInt(state.lastDistributionBlock)).sort((a, b) => Number(BigInt(a.block) - BigInt(b.block))) };
      } catch (e) { note("rpc.rewards", e); }

      // Runtime history: bisection with every probe cached.
      log("phase runtime");
      try {
        const probes = store.get("runtime-probes", {});
        const probe = async (nBlock) => {
          if (probes[nBlock]) return probes[nBlock];
          const s = await api.specAt(nBlock);
          probes[nBlock] = `${s.spec_name} ${s.spec_version}`;
          store.put("runtime-probes", probes); unit(`probe ${nBlock}`);
          return probes[nBlock];
        };
        const codeUpdatedNear = async (b) => {
          for (const x of [b, b - 1]) {
            const evs = await api.blockEvents(x);
            if (evs.some((e) => e.section === "system" && e.method === "CodeUpdated")) return x;
          }
          return null;
        };
        const rt = await extendRuntimeHistory(store.get("runtime", null), hi.number, { probe, codeUpdatedNear });
        store.put("runtime", rt); unit("runtime");
        bundle.runtime = rt;
      } catch (e) { note("rpc.runtime", e); }

      // Agent identities: a sample from storage, each checked for its AgentRegistered event. Cached:
      // an identity's registration block does not change.
      log("phase agents");
      try {
        const sample = await api.agents(hi.hash, hi.hash, AGENT_SAMPLE);
        if (sample) {
          const cache = store.get("agent-checks", {});
          const run = [];
          for (const a of sample) {
            if (cache[a.agent_id] === undefined) {
              const evs = Number.isSafeInteger(a.registered_at) && a.registered_at > 0 ? await api.blockEvents(a.registered_at) : [];
              cache[a.agent_id] = { block: a.registered_at, ok: evs.some((e) => agentRegisteredMatches(a, e)) };
              store.put("agent-checks", cache); unit(`agent ${a.agent_id}`);
            }
            run.push({ agent_id: a.agent_id, ...cache[a.agent_id] });
          }
          bundle.agentChecks = { run, total: Object.keys(cache).length, agreed: Object.values(cache).filter((c) => c.ok).length, failed: Object.entries(cache).filter(([, c]) => !c.ok).slice(0, 20).map(([id, c]) => ({ agent_id: id, block: c.block })) };
        }
      } catch (e) { note("rpc.agents", e); }

      // Settlement rows: the newest few, each checked against its block's events.
      log("phase settlement rows");
      if (bundle.settlementsNewest) {
        const ck = { checked: 0, agreed: 0, disagreed: 0, disagreements: [] };
        for (const row of bundle.settlementsNewest.filter((r) => Number(r.settledBlock) <= hi.number)) {
          try {
            const evs = await api.blockEvents(row.settledBlockHash ?? Number(row.settledBlock));
            ck.checked++;
            if (evs.some((e) => settledMatches(row, e))) ck.agreed++;
            else { ck.disagreed++; ck.disagreements.push({ channelId: row.channelId, block: row.settledBlock }); }
          } catch (e) { note("rpc.settlement_rows", e); }
        }
        bundle.settlementChecks = ck;
      }
      // Verifier txs: confirm each ProofVerified the explorer shows. Results are immutable, so cached.
      if (bundle.explorer.verifierTxs) {
        const cache = store.get("verifier-checks", {});
        const out = {};
        for (const [section, txs] of Object.entries(bundle.explorer.verifierTxs)) {
          const verified = txs.filter((t) => t.verified);
          let confirmed = 0;
          for (const t of verified) {
            if (cache[t.hash] === undefined) {
              const evs = await api.blockEvents(t.blockHash);
              cache[t.hash] = evs.some((e) => e.section === section && e.method === "ProofVerified");
              store.put("verifier-checks", cache); unit(`verifier ${t.hash}`);
            }
            if (cache[t.hash]) confirmed++;
          }
          out[section] = { explorer: verified.length, confirmed, txs: verified.map((t) => ({ hash: t.hash, timestamp_utc: iso(t.timestamp) })) };
        }
        for (const row of bundle.chain.verifiers?.rows ?? []) if (!out[row.pallet]) out[row.pallet] = { explorer: 0, confirmed: 0, txs: [] };
        bundle.verifierChecks = out;
      }
    }
  } catch (e) { note("rpc", e); } finally { await api?.disconnect?.()?.catch?.(() => {}); }

  // 3. Settlement totals at both window ends, from the cache.
  if (bundle._settlementCache && bundle.window.hi) {
    bundle.settlements = { lo: bundle.window.lo ? totalsUpTo(bundle._settlementCache, bundle.window.lo.number) : null, hi: totalsUpTo(bundle._settlementCache, bundle.window.hi.number), cursor: bundle._settlementCache.cursor };
    bundle.settlements.forward_rows = totalsUpTo(bundle._settlementCache, bundle.window.hi.number).forward_rows;
  }
  delete bundle._settlementCache;

  // 4. Releases: the explorer's pinned digest vs the registry's digest for the same tag.
  try { bundle.releases = await checkReleases(bundle.explorer.operatorReleases, getJson, { fetchImpl }); } catch (e) { note("ghcr", e); }

  // 5. Faucet window, release history.
  const asOfBlock = bundle.window.hi ?? null;
  const runNow = now();
  const lo = bundle.window.lo;
  if (lo && bundle.faucet?.chain_lo?.nonce) {
    const cur = { block: lo.number, time_ms: lo.time_ms, nonce: bundle.faucet.chain_lo.nonce };
    bundle.faucetWindow = faucetWindow(store.get("faucet-window", null), cur, bundle.faucetWalk);
    store.put("faucet-window", cur);
  }
  if (asOfBlock) {
    bundle.releaseHistory = updateReleaseHistory(store.get("release-history", []), bundle.releases, { block: asOfBlock.number, time_utc: iso(asOfBlock.time_ms) });
    store.put("release-history", bundle.releaseHistory);
  }

  if (bundlePath) writeJsonAtomic(bundlePath, bundle); // raw readings, for recording test fixtures

  // 6. Metrics and output.
  const previous = readJson(join(outDir, "latest.json"), null);
  const asOf = asOfBlock ? { block: asOfBlock.number, hash: asOfBlock.hash, time_utc: iso(asOfBlock.time_ms) } : null;
  const metrics = carryLastMatch(buildMetrics(bundle), previous?.metrics, asOf);
  const scalar = metrics.filter((m) => m.kind !== "table");
  const doc = {
    $schema: SCHEMA_ID, schema_version: SCHEMA_VERSION, generator: "flopscan", network,
    generated_at_utc: iso(runNow), as_of: asOf,
    window: { lo: bundle.window.lo ? { block: bundle.window.lo.number, hash: bundle.window.lo.hash, time_utc: iso(bundle.window.lo.time_ms) } : null, hi: asOf },
    sources: { rpc: { url: rpcUrl ?? "https://rpc.devnet.flop.network", ok: Boolean(bundle.window.hi) }, explorer: { url: ex.base, ok: Boolean(h1), indexed_head: h1?.head ?? null }, errors },
    summary: { match: scalar.filter((m) => m.status === STATUS.MATCH).length, mismatch: scalar.filter((m) => m.status === STATUS.MISMATCH).length, pending: scalar.filter((m) => m.status === STATUS.PENDING).length },
    disclaimer: DISCLAIMER,
    metrics,
  };
  if (asOfBlock) {
    const history = store.get("history", []);
    history.push({ block: asOfBlock.number, time_utc: iso(asOfBlock.time_ms), ...doc.summary });
    store.put("history", history.slice(-HISTORY_KEEP));
  }
  writeJsonAtomic(join(outDir, "latest.json"), doc);
  writeJsonAtomic(join(outDir, "history.json"), { $schema: SCHEMA_ID, schema_version: SCHEMA_VERSION, network, runs: store.get("history", []) });
  return doc;
}

/** Does a chain event record the registration of this storage row? Exact id and owner. */
export function agentRegisteredMatches(agent, ev) {
  if (!ev || ev.section !== "agentIdentity" || ev.method !== "AgentRegistered") return false;
  const d = Array.isArray(ev.data) ? { agent_id: ev.data[0], owner: ev.data[1] } : ev.data ?? {};
  return String(d.agent_id ?? d.agentId) === agent.agent_id && String(d.owner) === agent.owner;
}

export function updateReleaseHistory(prev, releases, entry) {
  const out = [...prev];
  for (const r of releases ?? []) {
    if (!r.explorer_digest || r.explorer_digest !== r.registry_digest) continue; // only versions both sides agree on
    if (out.some((x) => x.component === r.component && x.version === r.version)) continue;
    out.push({ component: r.component, version: r.version, digest: r.explorer_digest, first_seen_block: entry.block, first_seen_utc: entry.time_utc });
  }
  return out;
}

/** Parse `ghcr.io/owner/repo/name:vX@sha256:...` from the explorer and ask the registry for vX. */
export async function checkReleases(operatorReleases, getJson, { fetchImpl = globalThis.fetch } = {}) {
  if (!operatorReleases) return null;
  const out = [];
  for (const [component, rel] of Object.entries(operatorReleases)) {
    if (!rel || typeof rel.image !== "string") continue;
    const m = /^ghcr\.io\/([a-z0-9._/-]+):v?([0-9A-Za-z._-]+)@(sha256:[0-9a-f]{64})$/.exec(rel.image);
    if (!m) continue;
    const [, repo, tag, digest] = m;
    let registry = null;
    try {
      const tok = await getJson(`${GHCR}/token?scope=repository:${repo}:pull`);
      const res = await fetchImpl(`${GHCR}/v2/${repo}/manifests/v${tag}`, { method: "HEAD", headers: { authorization: `Bearer ${tok.token}`, accept: "application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json, application/vnd.docker.distribution.manifest.list.v2+json" } });
      if (res.ok) registry = res.headers.get("docker-content-digest");
    } catch { registry = null; }
    out.push({ component, version: String(rel.latest ?? tag), minimum: rel.minimum ?? null, image: `ghcr.io/${repo}:v${tag}`, explorer_digest: digest, registry_digest: registry });
  }
  return out;
}
