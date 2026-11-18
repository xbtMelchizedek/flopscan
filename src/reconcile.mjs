// The banteg rule as code: a metric gets a value only when two independent sources agree.
// Otherwise the metric carries every source's reading and a status that says why it has no value.
//
//   match     two or more sources were read and agree (exactly, or bracketed: see below)
//   mismatch  two or more sources were read and disagree; `delta` and every reading are kept
//   pending   fewer than two sources could be read this run (RPC down, endpoint missing)
//
// Readings are strings of integers (planck, counts) or plain strings (versions, digests).
// Integer comparison is BigInt; nothing is parsed as a float.

export const STATUS = Object.freeze({ MATCH: "match", MISMATCH: "mismatch", PENDING: "pending" });

const isInt = (v) => typeof v === "string" && /^-?\d+$/.test(v);

/** A reading from one source. `value` null means the source was not readable this run. */
export function reading(source, value, extra = {}) {
  if (value !== null && value !== undefined && typeof value !== "string") value = String(value);
  const out = { source, value: value ?? null, ...extra };
  // Provenance is only kept when it is well formed; a bad block or hash is dropped, not published.
  if (!Number.isSafeInteger(out.block) || out.block < 0) delete out.block;
  if (typeof out.hash !== "string" || !/^0x[0-9a-f]{64}$/.test(out.hash)) delete out.hash;
  return out;
}

/**
 * Exact agreement among the readings that have a value. Needs >= 2 such readings.
 * Readings flagged `context: true` are shown but never decide the status (a service's self-report).
 */
export function reconcileExact(readings) {
  const deciding = readings.filter((r) => !r.context && r.value !== null);
  if (deciding.length < 2) return { status: STATUS.PENDING, value: null, method: "exact", readings };
  const first = deciding[0].value;
  const agree = deciding.every((r) => r.value === first);
  if (agree) return { status: STATUS.MATCH, value: first, method: "exact", readings };
  const ints = deciding.every((r) => isInt(r.value));
  let delta = null;
  if (ints) {
    const vs = deciding.map((r) => BigInt(r.value));
    const max = vs.reduce((a, b) => (b > a ? b : a));
    const min = vs.reduce((a, b) => (b < a ? b : a));
    delta = String(max - min);
  }
  return { status: STATUS.MISMATCH, value: null, method: "exact", delta, readings };
}

/**
 * A monotone counter read from the chain at the start (lo) and end (hi) of the explorer's read
 * window, and once from the explorer somewhere inside it. They agree when lo <= explorer <= hi.
 * The value reported is the explorer's, because it is the one known to sit inside the window.
 */
export function reconcileBracketed(lo, hi, observed) {
  const readings = [lo, hi, observed];
  if ([lo, hi, observed].some((r) => r.value === null)) {
    // One chain end missing: fall back to an exact check against the end we have.
    const chain = hi.value !== null ? hi : lo;
    return { ...reconcileExact([chain, observed]), method: "bracketed", readings };
  }
  if (![lo.value, hi.value, observed.value].every(isInt)) throw new TypeError("bracketed needs integer readings");
  const [a, b, x] = [BigInt(lo.value), BigInt(hi.value), BigInt(observed.value)];
  const low = a < b ? a : b;
  const high = a < b ? b : a;
  if (low <= x && x <= high) return { status: STATUS.MATCH, value: observed.value, method: "bracketed", readings };
  const delta = String(x < low ? low - x : x - high);
  return { status: STATUS.MISMATCH, value: null, method: "bracketed", delta, readings };
}

/**
 * Row-by-row: `left` and `right` are maps id -> comparable object (JSON-able). Every id in either
 * side is checked. Agreement needs the same id set and equal objects for every id.
 */
export function reconcileRows(left, right, { leftName = "a", rightName = "b", limitShown = 20 } = {}) {
  const ids = new Set([...left.keys(), ...right.keys()]);
  const disagreements = [];
  let agreed = 0;
  for (const id of [...ids].sort()) {
    const a = left.get(id);
    const b = right.get(id);
    const ja = a === undefined ? null : stable(a);
    const jb = b === undefined ? null : stable(b);
    if (ja !== null && ja === jb) agreed++;
    else disagreements.push({ id, [leftName]: a ?? null, [rightName]: b ?? null });
  }
  const checked = ids.size;
  const status = checked === 0 ? STATUS.MATCH : disagreements.length === 0 ? STATUS.MATCH : STATUS.MISMATCH;
  return { status, checked, agreed, disagreed: disagreements.length, disagreements: disagreements.slice(0, limitShown) };
}

/** Key-sorted JSON, so {a,b} and {b,a} compare equal. */
export function stable(v) {
  if (Array.isArray(v)) return `[${v.map(stable).join(",")}]`;
  if (v && typeof v === "object") return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(",")}}`;
  return JSON.stringify(v);
}

/** Combine several sub-results into one status: any mismatch wins, then any pending, else match. */
export function worst(statuses) {
  if (statuses.includes(STATUS.MISMATCH)) return STATUS.MISMATCH;
  if (statuses.includes(STATUS.PENDING) || statuses.length === 0) return STATUS.PENDING;
  return STATUS.MATCH;
}
