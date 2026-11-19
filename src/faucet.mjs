// Faucet transactions between two scans, counted two ways over the same block range:
//   chain     the signer's nonce at this run's window start minus the nonce at the last run's
//   explorer  transactions the explorer lists with `sender` = signer and a block timestamp in
//             (last window start, this window start]
// Both ends are blocks the explorer had already indexed when the run began, so its list is
// complete for the range. Block timestamps strictly increase, so a time range is a block range.
//
// The explorer's lifetime `txCount` also counts transactions that only touch the account
// (refills sent to it), so it is not the nonce and is shown as context only.

const PAGE = 100;
export const MAX_FAUCET_PAGES = 60; // ~6,000 transactions: about two days of devnet faucet traffic
const isInt = (v) => typeof v === "string" && /^\d+$/.test(v);

/**
 * Newest-first walk of the signer's transactions, back to `sinceMs` (exclusive). Returns
 * `{ complete, rows: [{ hash, time_ms }] }` for rows the signer sent. `complete` is false when the
 * walk hit `maxPages` before reaching `sinceMs`; the window is then left pending, not undercounted.
 */
export async function walkSignerTxs(fetchPage, signer, sinceMs, { maxPages = MAX_FAUCET_PAGES } = {}) {
  const rows = new Map();
  for (let page = 0; page < maxPages; page++) {
    const body = await fetchPage(page * PAGE, PAGE);
    const data = Array.isArray(body) ? body : body?.data;
    if (!Array.isArray(data)) throw new Error("account transactions: no data array");
    let reachedSince = false;
    for (const t of data) {
      const time = t?.timestamp;
      if (!Number.isSafeInteger(time) || typeof t.hash !== "string") throw new Error("account transactions: row without hash or timestamp");
      if (time <= sinceMs) { reachedSince = true; continue; }
      if (t.sender === signer) rows.set(t.hash, { hash: t.hash, time_ms: time });
    }
    if (reachedSince || data.length < PAGE) return { complete: true, rows: [...rows.values()] };
  }
  return { complete: false, rows: [...rows.values()] };
}

/**
 * `prev` and `cur` are `{ block, time_ms, nonce }` at two window starts. Returns the two counts
 * as integer strings (null when unknown) and the range they cover.
 */
export function faucetWindow(prev, cur, walk) {
  const usable = (x) => x && Number.isSafeInteger(x.block) && Number.isSafeInteger(x.time_ms) && isInt(x.nonce);
  if (!usable(prev) || !usable(cur) || cur.block <= prev.block) return null;
  const chain = String(BigInt(cur.nonce) - BigInt(prev.nonce));
  const explorer = walk?.complete ? String(walk.rows.filter((r) => r.time_ms > prev.time_ms && r.time_ms <= cur.time_ms).length) : null;
  return { from_block: prev.block, to_block: cur.block, from_ms: prev.time_ms, to_ms: cur.time_ms, chain_nonce_delta: chain, explorer_sent: explorer };
}
