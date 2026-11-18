import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { extendRuntimeHistory, findBoundaries } from "../src/runtime.mjs";

/** A chain whose spec bumps at the given blocks. */
function chain(bounds) {
  const sorted = [...new Set(bounds)].sort((a, b) => a - b);
  const calls = [];
  const probe = async (n) => { calls.push(n); return `rt ${100 + sorted.filter((b) => b <= n).length}`; };
  return { sorted, probe, calls };
}

test("bisection finds exactly the upgrade blocks, in O(k log n) probes (property)", async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 2, max: 4_000_000 }), { maxLength: 12 }), async (bounds) => {
    const c = chain(bounds);
    const found = await findBoundaries(1, 4_000_000, c.probe);
    assert.deepEqual(found.map((b) => b.block), c.sorted);
    const k = Math.max(1, c.sorted.length);
    assert.ok(c.calls.length <= 2 + k * 23, `${c.calls.length} probes for ${k} bounds`);
  }), { numRuns: 60 });
});

test("incremental extension equals one shot, whatever the split points (property)", async () => {
  await fc.assert(fc.asyncProperty(fc.uniqueArray(fc.integer({ min: 2, max: 100_000 }), { maxLength: 8 }), fc.uniqueArray(fc.integer({ min: 2, max: 100_000 }), { maxLength: 4 }), async (bounds, cuts) => {
    const c = chain(bounds);
    const codeUpdatedNear = async (b) => b;
    const oneShot = await extendRuntimeHistory(null, 100_000, { probe: c.probe, codeUpdatedNear });
    let st = null;
    for (const h of [...cuts.sort((a, b) => a - b), 100_000]) st = await extendRuntimeHistory(st, h, { probe: c.probe, codeUpdatedNear });
    assert.deepEqual(st, oneShot);
    assert.equal(oneShot.spans.length, c.sorted.length + 1);
    for (let i = 1; i < oneShot.spans.length; i++) assert.equal(oneShot.spans[i - 1].to_block + 1, oneShot.spans[i].from_block);
  }), { numRuns: 60 });
});

test("a head at or below the checked block changes nothing", async () => {
  const c = chain([10]);
  const st = await extendRuntimeHistory(null, 50, { probe: c.probe, codeUpdatedNear: async () => null });
  const n = c.calls.length;
  assert.deepEqual(await extendRuntimeHistory(st, 40, { probe: c.probe, codeUpdatedNear: async () => null }), st);
  assert.equal(c.calls.length, n);
});
