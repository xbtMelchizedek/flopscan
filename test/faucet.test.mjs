import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { faucetWindow, walkSignerTxs } from "../src/faucet.mjs";

const S = "5Signer";
const pager = (rows) => async (offset, limit) => rows.slice(offset, offset + limit);

test("walk stops at the first row at or before `since`, counts only the signer's rows", async () => {
  const rows = [];
  for (let t = 500; t >= 1; t--) rows.push({ hash: `h${t}`, sender: t % 7 === 0 ? "5Other" : S, timestamp: t });
  let pages = 0;
  const w = await walkSignerTxs(async (o, l) => { pages++; return rows.slice(o, o + l); }, S, 260);
  assert.equal(w.complete, true);
  assert.equal(pages, 3);
  assert.equal(w.rows.length, [...Array(240).keys()].map((i) => 261 + i).filter((t) => t % 7 !== 0).length);
});

test("walk that runs out of pages is incomplete, and the window then has no explorer count", async () => {
  const rows = Array.from({ length: 1000 }, (_, i) => ({ hash: `h${i}`, sender: S, timestamp: 2000 - i }));
  const w = await walkSignerTxs(pager(rows), S, 0, { maxPages: 2 });
  assert.equal(w.complete, false);
  const win = faucetWindow({ block: 1, time_ms: 0, nonce: "0" }, { block: 9, time_ms: 5000, nonce: "200" }, w);
  assert.equal(win.explorer_sent, null);
  assert.equal(win.chain_nonce_delta, "200");
});

test("walk refuses rows without a hash or an integer timestamp", async () => {
  await assert.rejects(walkSignerTxs(pager([{ hash: "a", sender: S, timestamp: "soon" }]), S, 0), /timestamp/);
  await assert.rejects(walkSignerTxs(async () => ({ nope: 1 }), S, 0), /no data array/);
});

test("window counts exactly the rows in (from, to]: model check (property)", async () => {
  await fc.assert(fc.asyncProperty(fc.array(fc.record({ t: fc.integer({ min: 1, max: 400 }), mine: fc.boolean() }), { maxLength: 300 }), fc.integer({ min: 0, max: 200 }), fc.integer({ min: 0, max: 400 }), async (xs, from, span) => {
    const to = from + span + 1;
    const rows = xs.map((x, i) => ({ hash: `h${i}`, sender: x.mine ? S : "5X", timestamp: x.t })).sort((a, b) => b.timestamp - a.timestamp);
    const w = await walkSignerTxs(pager(rows), S, from);
    const win = faucetWindow({ block: 10, time_ms: from, nonce: "5" }, { block: 20, time_ms: to, nonce: "9" }, w);
    const model = xs.filter((x) => x.mine && x.t > from && x.t <= to).length;
    return win.explorer_sent === String(model);
  }), { numRuns: 200 });
});

test("window is null for a non-advancing or malformed range", () => {
  assert.equal(faucetWindow(null, { block: 2, time_ms: 2, nonce: "1" }, null), null);
  assert.equal(faucetWindow({ block: 5, time_ms: 5, nonce: "1" }, { block: 5, time_ms: 5, nonce: "1" }, null), null);
  assert.equal(faucetWindow({ block: 1, time_ms: 1, nonce: "1.5" }, { block: 5, time_ms: 5, nonce: "2" }, null), null);
});
