// Chain readers over a fake @polkadot/api: a missing item is null, a failed read is an error.
import assert from "node:assert/strict";
import { test } from "node:test";
import { readCounters, readKeyCounts } from "../src/sources/rpc.mjs";

const codec = (v) => ({ toBigInt: () => BigInt(v), toString: () => String(v), toJSON: () => v });
function fakeApi({ fail = null, drop = [] } = {}) {
  const item = (pallet, name, v) => async () => { if (fail === `${pallet}.${name}`) throw new Error("[503]: Service Unavailable"); return v; };
  const pallets = {
    computeChannel: { totalMinerPaid: item("computeChannel", "totalMinerPaid", codec(5)) },
    balances: { totalIssuance: item("balances", "totalIssuance", codec(9)) },
  };
  for (const p of drop) delete pallets[p];
  return { at: async () => ({ query: pallets }), query: {}, rpc: { state: {} } };
}

test("readCounters: an item this runtime lacks is null; a present item is read", async () => {
  const c = await readCounters(fakeApi({ drop: ["balances"] }), "0x1");
  assert.equal(c.compute.miner_paid, "5");
  assert.equal(c.supply.total_issuance, null);
  assert.equal(c.agents.agent_count, null);
});

test("readCounters: a failed read (503) throws instead of becoming a missing item", async () => {
  await assert.rejects(readCounters(fakeApi({ fail: "balances.totalIssuance" }), "0x1"), /503/);
});

test("readKeyCounts: a map this runtime lacks is null", async () => {
  const k = await readKeyCounts(fakeApi(), "0x1");
  assert.deepEqual(Object.values(k), [null, null, null, null, null, null, null]);
});
