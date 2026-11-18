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
