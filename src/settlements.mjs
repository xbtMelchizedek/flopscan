// Settlement rows from the explorer, kept as a compact cache with a block cursor so each run
// fetches only what is new. Rows are deduped by (channel, block, event index): a page that
// shifts under us while we read it yields duplicates, never gaps.

export const REFETCH_MARGIN_BLOCKS = 600; // re-read this far behind the cursor in case of late indexing

export function rowId(r) {
  return `${r.channelId}:${r.settledBlock}:${r.eventIndex ?? r.extrinsicIndex ?? ""}`;
}

/** Compact row: [block, minerPaid, burned, aggregateGn, marketKind]. */
export function compact(r) {
  return [Number(r.settledBlock), String(r.minerPaid ?? "0"), String(r.burned ?? "0"), String(r.aggregateGn ?? "0"), String(r.marketKind ?? "")];
}

export function mergeRows(cache, rows) {
  const next = { cursor: cache?.cursor ?? 0, rows: { ...(cache?.rows ?? {}) } };
  for (const r of rows) {
    const b = Number(r.settledBlock);
    if (!Number.isSafeInteger(b) || b < 0) throw new Error(`settlement row with bad block ${r.settledBlock}`);
    if (!/^\d+$/.test(String(r.minerPaid ?? "0")) || !/^\d+$/.test(String(r.burned ?? "0"))) throw new Error(`settlement row ${r.channelId} has a non-integer amount`);
    next.rows[rowId(r)] = compact(r);
    if (b > next.cursor) next.cursor = b;
  }
  return next;
}

/** Sums over rows with block <= upTo. */
export function totalsUpTo(cache, upTo) {
  let minerPaid = 0n, burned = 0n, rows = 0, forward = 0;
  for (const [b, paid, burn, , kind] of Object.values(cache?.rows ?? {})) {
    if (b > upTo) continue;
    minerPaid += BigInt(paid);
    burned += BigInt(burn);
    rows++;
    if (kind && kind !== "spot") forward++;
  }
  return { miner_paid: String(minerPaid), burned: String(burned), rows: String(rows), forward_rows: forward };
}

/** Does a chain Settled event match an explorer row? */
export function settledMatches(row, ev) {
  if (!ev || ev.section !== "computeChannel" || ev.method !== "Settled") return false;
  const d = Array.isArray(ev.data) ? { channel_id: ev.data[0], miner_paid: ev.data[1], burned: ev.data[2], aggregate_gn: ev.data[3] } : ev.data;
  const hex = (x) => String(x).toLowerCase();
  const int = (x) => (typeof x === "string" && x.startsWith("0x") ? BigInt(x) : BigInt(x ?? 0)).toString();
  return hex(d.channel_id ?? d.channelId) === hex(row.channelId)
    && int(d.miner_paid ?? d.minerPaid) === String(row.minerPaid)
    && int(d.burned) === String(row.burned)
    && int(d.aggregate_gn ?? d.aggregateGn) === String(row.aggregateGn);
}
