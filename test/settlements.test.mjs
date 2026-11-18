import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { mergeRows, rowId, settledMatches, totalsUpTo } from "../src/settlements.mjs";

const row = fc.record({
  channelId: fc.stringMatching(/^0x[0-9a-f]{8}$/),
  settledBlock: fc.integer({ min: 1, max: 5_000_000 }),
  eventIndex: fc.integer({ min: 0, max: 50 }),
  minerPaid: fc.bigInt({ min: 0n, max: 10n ** 24n }).map(String),
  burned: fc.bigInt({ min: 0n, max: 10n ** 20n }).map(String),
  aggregateGn: fc.bigInt({ min: 0n, max: 10n ** 9n }).map(String),
  marketKind: fc.constantFrom("spot", "forward"),
});

test("merge is idempotent and order-independent (property)", () => {
  fc.assert(fc.property(fc.array(row, { maxLength: 40 }), (rows) => {
    const once = mergeRows(null, rows);
    const twice = mergeRows(once, rows);
    const reversed = mergeRows(null, [...rows].reverse());
    const t = (c) => JSON.stringify(totalsUpTo(c, 1e9));
    return t(once) === t(twice) && t(once) === t(reversed) && once.cursor === reversed.cursor;
  }));
});

test("overlapping pages (a shifted page) never double count (property)", () => {
  fc.assert(fc.property(fc.uniqueArray(row, { selector: rowId, minLength: 1, maxLength: 30 }), fc.nat(), (rows, cut) => {
    const k = cut % rows.length;
    const a = mergeRows(null, rows.slice(0, k + 1));
    const b = mergeRows(a, rows.slice(k)); // row k is read twice
    const all = mergeRows(null, rows);
    return JSON.stringify(totalsUpTo(b, 1e9)) === JSON.stringify(totalsUpTo(all, 1e9));
  }));
});

test("totals are monotone in the block bound and sum exactly (property)", () => {
  fc.assert(fc.property(fc.uniqueArray(row, { selector: rowId, maxLength: 30 }), fc.integer({ min: 0, max: 5_000_000 }), (rows, b) => {
    const c = mergeRows(null, rows);
    const lo = totalsUpTo(c, b); const hi = totalsUpTo(c, b + 1000);
    const want = rows.filter((r) => r.settledBlock <= b).reduce((a, r) => a + BigInt(r.minerPaid), 0n);
    return BigInt(lo.miner_paid) <= BigInt(hi.miner_paid) && lo.miner_paid === String(want);
  }));
});

test("malformed rows are refused, not summed", () => {
  const ok = { channelId: "0x1", settledBlock: 5, minerPaid: "1", burned: "0", aggregateGn: "1" };
  assert.throws(() => mergeRows(null, [{ ...ok, minerPaid: "1.5" }]), /non-integer/);
  assert.throws(() => mergeRows(null, [{ ...ok, minerPaid: "-3" }]), /non-integer/);
  assert.throws(() => mergeRows(null, [{ ...ok, settledBlock: "abc" }]), /bad block/);
  assert.throws(() => mergeRows(null, [{ ...ok, settledBlock: -1 }]), /bad block/);
  assert.throws(() => mergeRows(null, [{ ...ok, minerPaid: "1e18" }]), /non-integer/);
});

test("settledMatches: positional and named event data; any field off fails", () => {
  const r = { channelId: "0xAB", minerPaid: "100", burned: "0", aggregateGn: "7" };
  const ev = (data) => ({ section: "computeChannel", method: "Settled", data });
  assert.ok(settledMatches(r, ev(["0xab", "100", "0", "7", true])));
  assert.ok(settledMatches(r, ev({ channel_id: "0xab", miner_paid: "0x64", burned: 0, aggregate_gn: 7 })));
  assert.ok(!settledMatches(r, ev(["0xab", "101", "0", "7", true])));
  assert.ok(!settledMatches(r, ev(["0xac", "100", "0", "7", true])));
  assert.ok(!settledMatches(r, ev(["0xab", "100", "1", "7", true])));
  assert.ok(!settledMatches(r, ev(["0xab", "100", "0", "8", true])));
  assert.ok(!settledMatches(r, { section: "computeChannel", method: "TimedOutRefunded", data: ["0xab", "100", "0", "7"] }));
});
