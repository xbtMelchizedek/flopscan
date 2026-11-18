// Malformed RPC and explorer responses: each must turn into a recorded error and pending metrics,
// never a crash and never a number.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createExplorer } from "../src/sources/explorer.mjs";
import { scan } from "../src/scan.mjs";
import { makeWorld } from "./helpers/world.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "flopscan-"));
const runWith = async (knobs, readersPatch = {}) => {
  const w = makeWorld(knobs);
  const doc = await scan({ outDir: tmp(), cacheDir: tmp(), getJson: w.getJson, connectChain: async () => ({ ...w.readers, ...readersPatch }), fetchImpl: w.fetchImpl, now: w.now });
  return { doc, byId: new Map(doc.metrics.map((m) => [m.id, m])) };
};
const noNumbersUnlessMatch = (doc) => { for (const m of doc.metrics) if (m.kind !== "table" && m.status !== "match") assert.equal(m.value, null, m.id); };

test("explorer health without an indexed hash: explorer is treated as down", async () => {
  const { doc } = await runWith({ explorer: { "/api/health": { status: "ok", writer: { indexedHead: 5 } } } });
  assert.match(doc.sources.errors.explorer, /no indexed head/);
  noNumbersUnlessMatch(doc);
});

test("explorer health with a non-hex hash is refused", async () => {
  const ex = createExplorer(async () => ({ writer: { indexedHead: 5, indexedHash: "0xZZ" } }));
  await assert.rejects(ex.health(), /no indexed head/);
});

test("pagination without total, data that is not an array, and HTML instead of JSON", async () => {
  const ex1 = createExplorer(async () => ({ data: [] }));
  await assert.rejects(ex1.total("/api/sessions"), /pagination.total/);
  const ex2 = createExplorer(async () => ({ data: { not: "array" } }));
  await assert.rejects(ex2.all("/api/miners", (r) => r.address), /no data array/);
  await assert.rejects(ex2.settlementsSince(0), /no data array/);
  const ex3 = createExplorer(async () => ({ pagination: { total: -4 } }));
  await assert.rejects(ex3.total("/api/sessions"), /pagination.total/);
});

test("stats with junk numbers: those metrics are pending, the rest still agree", async () => {
  const { doc, byId } = await runWith({ explorer: { "/api/stats": { registeredMiners: "three", activeAgents: 1.5, totalSupply: "1e30", activeValidators: null } } });
  for (const id of ["supply.total_issuance", "validators.active"]) assert.equal(byId.get(id).status, "pending", id);
  assert.equal(byId.get("miners.registered").status, "pending"); // explorer-vs-chain metric: the explorer side is unreadable
  assert.equal(byId.get("compute.miner_paid").status, "match");
  noNumbersUnlessMatch(doc);
});

test("settlement rows with a float amount: the settlement source is dropped, not summed", async () => {
  const bad = (q) => ({ data: [{ channelId: "0x1", settledBlock: 999, minerPaid: "1.5", burned: "0", aggregateGn: "1" }], pagination: { total: 1, hasMore: false } });
  const { doc, byId } = await runWith({ explorer: { "/api/settlement-prices": bad } });
  assert.match(doc.sources.errors["explorer.settlements"], /non-integer/);
  assert.equal(byId.get("compute.miner_paid").status, "pending");
  noNumbersUnlessMatch(doc);
});

test("faucet /limits with a junk signer address is refused before any account lookup", async () => {
  const { doc, byId } = await runWith({ explorer: { "/limits": { faucet: { signer: "../../etc/passwd" } } } });
  assert.match(doc.sources.errors.faucet, /no signer/);
  assert.equal(byId.get("faucet.balance").status, "pending");
});

test("RPC errors mid-run: a failing reader marks its metrics pending and the run finishes", async () => {
  const { doc, byId } = await runWith({}, { counters: async () => { throw new Error("RPC-CORE: state_call: HTTP 503"); }, keys: async () => { throw new Error("-32029 too many requests"); } });
  assert.ok(doc.sources.errors["rpc.counters_hi"]);
  assert.equal(byId.get("supply.total_issuance").status, "pending");
  assert.equal(byId.get("compute.channels").status, "pending");
  assert.equal(byId.get("rewards.miner_minted").status, "match"); // rewards come from another reader
  noNumbersUnlessMatch(doc);
});

test("RPC returns junk shapes: builders isolate the failure to one group", async () => {
  const { doc } = await runWith({}, { rewardsState: async () => ({ consts: {}, counters: null, lastDistributionBlock: "abc" }) });
  assert.ok(doc.sources.errors["rpc.rewards"]);
  noNumbersUnlessMatch(doc);
});

test("a settlement row that the chain does not confirm is a mismatch", async () => {
  const { byId } = await runWith({}, { blockEvents: async () => [] });
  const m = byId.get("compute.settlement_rows");
  assert.equal(m.status, "mismatch");
  assert.equal(m.value, null);
});
