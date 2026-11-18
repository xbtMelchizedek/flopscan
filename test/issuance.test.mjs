import assert from "node:assert/strict";
import { test } from "node:test";
import { explainIssuance, isIssuanceEvent } from "../src/issuance.mjs";

const ev = (method, amount) => ({ section: "balances", method, amount: String(amount) });

test("mints and burns explain the delta exactly", () => {
  const r = explainIssuance(1000n, 1031n, [ev("Minted", 16), ev("Minted", 16), ev("Burned", 1), ev("Transfer", 999)]);
  assert.equal(r.ok, true);
  assert.equal(r.by_kind["balances.Minted"], "32");
  assert.equal(r.by_kind["balances.Transfer"], undefined);
});

test("an unexplained change fails and reports the gap", () => {
  const r = explainIssuance(1000n, 1100n, [ev("Minted", 16)]);
  assert.equal(r.ok, false);
  assert.equal(r.unexplained, "84");
});

test("Issued and Rescinded count; fee moves do not", () => {
  assert.equal(isIssuanceEvent("balances", "Issued"), true);
  assert.equal(isIssuanceEvent("balances", "Rescinded"), true);
  assert.equal(isIssuanceEvent("balances", "Withdraw"), false);
  assert.equal(isIssuanceEvent("balances", "Deposit"), false);
  assert.equal(explainIssuance(10n, 7n, [ev("Rescinded", 3)]).ok, true);
});
