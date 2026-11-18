// Resume after a crash: kill the scan after k saved units, rerun, and get the same answer as one
// clean run, without re-reading what was already saved.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { crashAfter, scan } from "../src/scan.mjs";
import { makeWorld } from "./helpers/world.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "flopscan-"));
const strip = (doc) => JSON.stringify(doc.metrics.map((m) => ({ ...m, last_match: undefined })));

test("crash after k units, resume, same output as a clean run; saved units are not re-read", async () => {
  const clean = makeWorld();
  const cleanDoc = await scan({ outDir: tmp(), cacheDir: tmp(), getJson: clean.getJson, connectChain: async () => clean.readers, fetchImpl: clean.fetchImpl, now: clean.now });
  const totalPeriods = clean.calls.period;
  assert.equal(totalPeriods, 10);

  for (const k of [1, 3, 7, 12, 20]) {
    const out = tmp(); const cache = tmp();
    const w1 = makeWorld();
    const crashed = await scan({ outDir: out, cacheDir: cache, getJson: w1.getJson, connectChain: async () => w1.readers, fetchImpl: w1.fetchImpl, now: w1.now, onUnit: crashAfter(k) }).then(() => false, (e) => /simulated crash/.test(e.message));
    // A crash inside a guarded section is recorded and the scan finishes; either way the cache holds the saved units.
    const w2 = makeWorld();
    const doc = await scan({ outDir: out, cacheDir: cache, getJson: w2.getJson, connectChain: async () => w2.readers, fetchImpl: w2.fetchImpl, now: w2.now });
    assert.equal(strip(doc), strip(cleanDoc), `k=${k} crashed=${crashed}`);
    assert.ok(w1.calls.period + w2.calls.period <= totalPeriods + 1, `k=${k}: ${w1.calls.period}+${w2.calls.period} period reads`);
  }
});

test("a second run with nothing new reads no reward periods and no runtime probes", async () => {
  const out = tmp(); const cache = tmp();
  const w1 = makeWorld();
  await scan({ outDir: out, cacheDir: cache, getJson: w1.getJson, connectChain: async () => w1.readers, fetchImpl: w1.fetchImpl, now: w1.now });
  const w2 = makeWorld();
  await scan({ outDir: out, cacheDir: cache, getJson: w2.getJson, connectChain: async () => w2.readers, fetchImpl: w2.fetchImpl, now: w2.now });
  assert.equal(w2.calls.period, 0);
  assert.equal(w2.calls.specAt, 0);
});

test("a period read that fails is retried on the next run, and the earlier ones are kept", async () => {
  const out = tmp(); const cache = tmp();
  const w1 = makeWorld({ failPeriodAt: 500 });
  const d1 = await scan({ outDir: out, cacheDir: cache, getJson: w1.getJson, connectChain: async () => w1.readers, fetchImpl: w1.fetchImpl, now: w1.now });
  assert.ok(d1.sources.errors["rpc.rewards"]);
  assert.equal(d1.metrics.find((m) => m.id === "rewards.periods").status, "pending");
  const saved = Object.keys(JSON.parse(readFileSync(join(cache, "reward-periods.json"), "utf8")));
  assert.deepEqual(saved, ["100", "200", "300", "400"]);
  const w2 = makeWorld();
  const d2 = await scan({ outDir: out, cacheDir: cache, getJson: w2.getJson, connectChain: async () => w2.readers, fetchImpl: w2.fetchImpl, now: w2.now });
  assert.equal(w2.calls.period, 6);
  assert.equal(d2.metrics.find((m) => m.id === "rewards.periods").status, "match");
});

test("settlement walk killed after its first page resumes at the saved offset, with no gaps or duplicates", async () => {
  const out = tmp(); const cache = tmp();
  const offsets = (w) => { const seen = []; const get = w.getJson; w.getJson = async (url) => { const u = new URL(url); if (u.pathname === "/api/settlement-prices") seen.push(Number(u.searchParams.get("offset"))); return get(url); }; return seen; };
  const w1 = makeWorld({ settlements: 250 });
  const first = offsets(w1);
  // The crash is thrown from the first saved unit, which is the first settlement page.
  await scan({ outDir: out, cacheDir: cache, getJson: (u) => w1.getJson(u), connectChain: async () => w1.readers, fetchImpl: w1.fetchImpl, now: w1.now, onUnit: crashAfter(0) }).catch(() => {});
  assert.deepEqual(first, [0]);
  const st = JSON.parse(readFileSync(join(cache, "settlements.json"), "utf8"));
  assert.equal(st.backfill.next_offset, 100, "backfill state saved mid-walk");
  assert.equal(Object.keys(st.rows).length, 100);

  const w2 = makeWorld({ settlements: 250 });
  const second = offsets(w2);
  const doc = await scan({ outDir: out, cacheDir: cache, getJson: (u) => w2.getJson(u), connectChain: async () => w2.readers, fetchImpl: w2.fetchImpl, now: w2.now });
  assert.deepEqual(second, [100, 200], "resumes at the saved offset, does not re-read page 0");
  const st2 = JSON.parse(readFileSync(join(cache, "settlements.json"), "utf8"));
  assert.equal(st2.backfill, null);
  assert.equal(Object.keys(st2.rows).length, 250);
  assert.equal(doc.metrics.find((m) => m.id === "compute.miner_paid").status, "match");
});
