import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { reading, reconcileBracketed, reconcileExact, reconcileRows, stable, STATUS, worst } from "../src/reconcile.mjs";

const big = fc.bigInt({ min: 0n, max: 10n ** 30n }).map(String);
const maybe = fc.option(big, { nil: null });

test("exact: a value appears only when >= 2 deciding readings exist and all agree (property)", () => {
  fc.assert(fc.property(fc.array(fc.record({ v: maybe, ctx: fc.boolean() }), { maxLength: 6 }), (rs) => {
    const readings = rs.map((r, i) => reading(`s${i}`, r.v, { context: r.ctx }));
    const out = reconcileExact(readings);
    const deciding = readings.filter((r) => !r.context && r.value !== null);
    if (deciding.length < 2) return out.status === STATUS.PENDING && out.value === null;
    const same = deciding.every((r) => r.value === deciding[0].value);
    if (same) return out.status === STATUS.MATCH && out.value === deciding[0].value;
    return out.status === STATUS.MISMATCH && out.value === null && BigInt(out.delta) > 0n;
  }));
});

test("exact: order of readings does not change the verdict (property)", () => {
  fc.assert(fc.property(fc.array(maybe, { minLength: 2, maxLength: 5 }), fc.integer(), (vals, seed) => {
    const a = vals.map((v, i) => reading(`s${i}`, v));
    const b = [...a].sort(() => ((seed = (seed * 1103515245 + 12345) | 0) & 1 ? 1 : -1));
    const x = reconcileExact(a); const y = reconcileExact(b);
    return x.status === y.status && x.value === y.value && x.delta === y.delta;
  }));
});

test("exact: context readings never decide", () => {
  const r = reconcileExact([reading("a", "1"), reading("svc", "2", { context: true })]);
  assert.equal(r.status, STATUS.PENDING);
  assert.equal(r.value, null);
});

test("bracketed: inside [lo, hi] matches with the observed value; outside mismatches by the gap (property)", () => {
  fc.assert(fc.property(fc.bigInt({ min: 0n, max: 10n ** 24n }), fc.bigInt({ min: 0n, max: 10n ** 6n }), fc.bigInt({ min: -(10n ** 6n), max: 2n * 10n ** 6n }), (lo, span, off) => {
    const hi = lo + span;
    const x = lo + off;
    const r = reconcileBracketed(reading("c", String(lo)), reading("c", String(hi)), reading("e", String(x)));
    const inside = x >= lo && x <= hi;
    if (inside) return r.status === STATUS.MATCH && r.value === String(x);
    const gap = x < lo ? lo - x : x - hi;
    return r.status === STATUS.MISMATCH && r.value === null && r.delta === String(gap);
  }));
});

test("bracketed: a missing chain end falls back to exact; a missing explorer is pending", () => {
  assert.equal(reconcileBracketed(reading("c", null), reading("c", "5"), reading("e", "5")).status, STATUS.MATCH);
  assert.equal(reconcileBracketed(reading("c", null), reading("c", "5"), reading("e", "6")).status, STATUS.MISMATCH);
  assert.equal(reconcileBracketed(reading("c", "4"), reading("c", "5"), reading("e", null)).status, STATUS.PENDING);
});

test("bracketed refuses non-integers instead of comparing strings", () => {
  assert.throws(() => reconcileBracketed(reading("c", "1.5"), reading("c", "2"), reading("e", "2")), TypeError);
});

test("rows: equal maps match; any changed, missing or extra row is reported (property)", () => {
  fc.assert(fc.property(fc.dictionary(fc.string({ minLength: 1, maxLength: 6 }), big, { maxKeys: 20 }), fc.nat(), (dict, k) => {
    const a = new Map(Object.entries(dict).map(([id, v]) => [id, { v }]));
    const same = reconcileRows(a, new Map(a));
    if (same.status !== STATUS.MATCH || same.disagreed !== 0 || same.agreed !== a.size) return false;
    if (a.size === 0) return true;
    const ids = [...a.keys()];
    const victim = ids[k % ids.length];
    const changed = new Map(a); changed.set(victim, { v: String(BigInt(dict[victim]) + 1n) });
    const dropped = new Map(a); dropped.delete(victim);
    return reconcileRows(a, changed).disagreed === 1 && reconcileRows(a, dropped).disagreed === 1 && reconcileRows(a, dropped).status === STATUS.MISMATCH;
  }));
});

test("stable() ignores key order", () => {
  assert.equal(stable({ a: 1, b: [1, { d: 2, c: 3 }] }), stable({ b: [1, { c: 3, d: 2 }], a: 1 }));
});

test("worst: mismatch beats pending beats match; empty is pending", () => {
  assert.equal(worst([STATUS.MATCH, STATUS.PENDING, STATUS.MISMATCH]), STATUS.MISMATCH);
  assert.equal(worst([STATUS.MATCH, STATUS.PENDING]), STATUS.PENDING);
  assert.equal(worst([STATUS.MATCH]), STATUS.MATCH);
  assert.equal(worst([]), STATUS.PENDING);
});
