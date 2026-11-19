import assert from "node:assert/strict";
import { test } from "node:test";
import fc from "fast-check";
import { esc, exactFlop, formatFlop, groupDigits } from "../src/format.mjs";

const planck = fc.bigInt({ min: -(10n ** 40n), max: 10n ** 40n });
// "< 0.01" reads back as 0: it claims only that |amount| is under the shown precision.
const back = (s) => { if (/< 0\.0*1$/.test(s)) return 0n; const neg = s.startsWith("-"); const [w, f = ""] = s.replace(/[-,]/g, "").split("."); const v = BigInt(w) * 10n ** 18n + BigInt((f + "0".repeat(18)).slice(0, 18)); return neg ? -v : v; };

test("exactFlop round-trips every planck amount (property)", () => {
  fc.assert(fc.property(planck, (p) => back(exactFlop(String(p))) === p));
});

test("formatFlop rounds toward zero and is off by less than 0.01 FLOP (property)", () => {
  fc.assert(fc.property(planck, (p) => {
    const shown = back(formatFlop(String(p)));
    const err = p - shown;
    return (p >= 0n ? err >= 0n : err <= 0n) && (err < 0n ? -err : err) < 10n ** 16n;
  }));
});

test("known values", () => {
  assert.equal(formatFlop("37324799999999999999999999"), "37,324,799.99");
  assert.equal(formatFlop("389836800000000000000000000"), "389,836,800");
  assert.equal(formatFlop("5"), "< 0.01");
  assert.equal(exactFlop("5"), "0.000000000000000005");
  assert.equal(groupDigits("-1234567"), "-1,234,567");
  assert.throws(() => formatFlop("1.5"), TypeError);
});

test("esc leaves no markup through (property)", () => {
  fc.assert(fc.property(fc.string(), (s) => !/[<>"']/.test(esc(s))));
});

test("a non-zero amount below the shown precision is never printed as 0", () => {
  assert.equal(formatFlop("1"), "< 0.01");
  assert.equal(formatFlop("-1"), "-< 0.01");
  assert.equal(formatFlop("9999999999999999"), "< 0.01");
  assert.equal(formatFlop("10000000000000000"), "0.01");
  assert.equal(formatFlop("0"), "0");
  fc.assert(fc.property(fc.bigInt({ min: 1n, max: 10n ** 30n }), (x) => formatFlop(String(x)) !== "0"));
});
