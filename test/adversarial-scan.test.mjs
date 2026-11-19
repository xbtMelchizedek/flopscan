// Adversarial compositions through a whole scan: one side claims something the other cannot back.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { scan } from "../src/scan.mjs";
import { makeWorld } from "./helpers/world.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "flopscan-adv-"));
const H = (n) => `0x${n.toString(16).padStart(64, "0")}`;
const run = (w, dirs = { out: tmp(), cache: tmp() }) => scan({ outDir: dirs.out, cacheDir: dirs.cache, getJson: w.getJson, connectChain: async () => w.readers, fetchImpl: w.fetchImpl, now: w.now });
const byId = (doc) => new Map(doc.metrics.map((m) => [m.id, m]));

test("a proof the explorer calls verified but whose block has no ProofVerified event is not counted", async () => {
  // Block 901 has no ProofVerified event in the fake chain; only block 900 does.
  const w = makeWorld({ explorer: { "/api/transactions": () => [
    { hash: H(77), blockHash: H(900), method: "submitProof", success: true, timestamp: 1, events: [{ section: "settlementSp1Pallet", method: "ProofVerified" }] },
    { hash: H(78), blockHash: H(901), method: "submitProof", success: true, timestamp: 2, events: [{ section: "settlementSp1Pallet", method: "ProofVerified" }] },
  ] } });
  const m = byId(await run(w)).get("verifiers.settlementSp1Pallet");
  assert.equal(m.status, "mismatch");
  assert.equal(m.value, null);
  assert.deepEqual(m.readings.map((r) => r.value), ["2", "1"]);
});

test("release history records a version only after explorer and registry digests agree", async () => {
  const dirs = { out: tmp(), cache: tmp() };
  const bad = byId(await run(makeWorld({ registryDigest: `sha256:${"b".repeat(64)}` }), dirs));
  assert.equal(bad.get("release.cli").status, "mismatch");
  assert.deepEqual(bad.get("release.history").rows, []);
  const good = byId(await run(makeWorld(), dirs));
  assert.equal(good.get("release.cli").status, "match");
  assert.deepEqual(good.get("release.history").rows.map((r) => [r.component, r.version]), [["cli", "0.1.9"]]);
});

test("an agent in storage whose registeredAt block has no AgentRegistered event is a mismatch", async () => {
  const ok = byId(await run(makeWorld())).get("agents.registration_rows");
  assert.equal(ok.status, "match");
  assert.equal(ok.value, "3");
  const bad = byId(await run(makeWorld({ dropAgentEvent: 402 }))).get("agents.registration_rows");
  assert.equal(bad.status, "mismatch");
  assert.equal(bad.value, null);
  assert.deepEqual(bad.detail.disagreements.map((d) => d.block), [402]);
});

test("agent registration check needs the exact owner, not just the id", async () => {
  const { agentRegisteredMatches } = await import("../src/scan.mjs");
  const a = { agent_id: `0x${"1".repeat(64)}`, owner: "5Owner1" };
  assert.equal(agentRegisteredMatches(a, { section: "agentIdentity", method: "AgentRegistered", data: [a.agent_id, "5Owner1"] }), true);
  assert.equal(agentRegisteredMatches(a, { section: "agentIdentity", method: "AgentRegistered", data: [a.agent_id, "5owner1"] }), false);
  assert.equal(agentRegisteredMatches(a, { section: "agentIdentity", method: "AgentUpdated", data: [a.agent_id, "5Owner1"] }), false);
  assert.equal(agentRegisteredMatches(a, { section: "agentIdentity", method: "AgentRegistered", data: [a.agent_id.toUpperCase(), "5Owner1"] }), false);
});

test("faucet balance: a tracked explorer balance must equal the chain at one window end", async () => {
  const lo = 995;
  const ok = byId(await run(makeWorld({ faucetExplorerBalance: String(10n ** 20n - BigInt(lo)) }))).get("faucet.balance");
  assert.equal(ok.status, "match");
  const bad = byId(await run(makeWorld({ faucetExplorerBalance: String(10n ** 20n - BigInt(lo) + 1n) }))).get("faucet.balance");
  assert.equal(bad.status, "mismatch");
  assert.equal(bad.value, null);
  assert.equal(bad.delta, "1");
});

test("release entries with an unsafe component name are dropped, not published", async () => {
  const w = makeWorld({ explorer: { "/api/operator-releases": () => ({
    cli: { latest: "0.1.9", image: `ghcr.io/flop-labs/flop-core/cli:v0.1.9@sha256:${"a".repeat(64)}` },
    "<img src=x>": { latest: "1", image: `ghcr.io/flop-labs/flop-core/x:v1@sha256:${"a".repeat(64)}` },
    "Bad Name": { latest: "1", image: `ghcr.io/flop-labs/flop-core/y:v1@sha256:${"a".repeat(64)}` },
  }) } });
  const ids = [...byId(await run(w)).keys()].filter((id) => id.startsWith("release."));
  assert.deepEqual(ids.sort(), ["release.cli", "release.history"]);
});

test("miner block rewards: storage totalRewardsEarned (0 on devnet) is context and does not decide", async () => {
  const m = byId(await run(makeWorld())).get("miners.rewards_total");
  assert.equal(m.status, "match");
  const st = m.readings.find((r) => r.source === "rpc.storage");
  assert.equal(st.value, "0");
  assert.equal(st.context, true);
});
