// The FLOP devnet explorer's public JSON API, read-only. Second source for most metrics.
// Every response is data: we take numbers and ids out of it, never instructions.

export const EXPLORER = "https://explorer.devnet.flop.network";
const PAGE = 100; // the API caps `limit` at 100

export function createExplorer(getJson, base = EXPLORER) {
  const get = (path) => getJson(`${base}${path}`);
  const total = async (path) => {
    const j = await get(`${path}${path.includes("?") ? "&" : "?"}limit=1&offset=0`);
    const t = j?.pagination?.total;
    if (!Number.isSafeInteger(t) || t < 0) throw new Error(`${path}: no pagination.total`);
    return t;
  };
  /** Every row of a paginated list. Rows are deduped by `idOf`, since inserts at the top shift pages. */
  const all = async (path, idOf, { max = 50_000 } = {}) => {
    const out = new Map();
    for (let offset = 0; offset < max; offset += PAGE) {
      const j = await get(`${path}${path.includes("?") ? "&" : "?"}limit=${PAGE}&offset=${offset}`);
      if (!Array.isArray(j?.data)) throw new Error(`${path}: no data array`);
      for (const r of j.data) out.set(idOf(r), r);
      if (!j.pagination?.hasMore || j.data.length === 0) break;
    }
    return [...out.values()];
  };
  return {
    base,
    get,
    total,
    all,
    /** The indexer's head; we pin chain reads to `indexedHash` so both sides read one block. */
    async health() {
      const h = await get("/api/health");
      const w = h?.writer ?? {};
      const head = Number(w.indexedHead ?? h.indexedHead);
      const hash = w.indexedHash;
      if (!Number.isSafeInteger(head) || typeof hash !== "string" || !/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("explorer health: no indexed head");
      return { head, hash, genesis: w.genesis ?? null, status: h.status, lag: h.headLag ?? null };
    },
    stats: () => get("/api/stats"),
    rewardsSummary: () => get("/api/rewards/summary"),
    rewardDistributions: () => all("/api/rewards/distributions", (r) => r.id ?? String(r.block_number)),
    miners: () => all("/api/miners", (r) => r.address),
    minerReliability: () => all("/api/miner-reliability", (r) => r.miner),
    inferenceSpend: () => get("/api/inference-spend?limit=1"),
    operatorReleases: () => get("/api/operator-releases"),
    account: (addr) => get(`/api/accounts/${encodeURIComponent(addr)}`),
    termCurve: () => get("/api/term-curve"),
    sectionTxs: (section) => all(`/api/transactions?section=${encodeURIComponent(section)}`, (r) => r.hash),
    sections: () => get("/api/transactions/sections"),
    /**
     * Settlement rows newer than `afterBlock`, newest first, stopping at the first page that
     * reaches back past it. Rows at exactly afterBlock+1.. are all returned; dedupe is the caller's.
     */
    async settlementsSince(afterBlock, { max = 200_000, startOffset = 0, onPage = () => {} } = {}) {
      const out = [];
      for (let offset = startOffset; offset < max; offset += PAGE) {
        const j = await get(`/api/settlement-prices?limit=${PAGE}&offset=${offset}`);
        if (!Array.isArray(j?.data)) throw new Error("settlement-prices: no data array");
        let older = false;
        const page = [];
        for (const r of j.data) {
          if (Number(r.settledBlock) > afterBlock) page.push(r);
          else older = true;
        }
        out.push(...page);
        onPage(page, offset + PAGE);
        if (older || !j.pagination?.hasMore || j.data.length === 0) break;
      }
      return out;
    },
  };
}

export const explorerLink = {
  block: (n) => `${EXPLORER}/blocks/${n}`,
  account: (a) => `${EXPLORER}/account/${a}`,
  miner: (a) => `${EXPLORER}/account/${a}`,
  tx: (h) => `${EXPLORER}/transactions/${h}`,
};
