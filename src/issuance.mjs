// Explain a change in `balances.totalIssuance` from the events in between.
// Delta(observed) = issuance(to) - issuance(from). Delta(events) = sum of events in (from, to]
// that change issuance. Anything left over is `unexplained` and fails the check.

const UP = new Set(["balances.Minted", "balances.Issued"]);
const DOWN = new Set(["balances.Burned", "balances.Rescinded"]);

/** @param {{section:string, method:string, amount:string}[]} events */
export function explainIssuance(issuanceFrom, issuanceTo, events) {
  let up = 0n;
  let down = 0n;
  const byKind = {};
  for (const e of events) {
    const key = `${e.section}.${e.method}`;
    const amount = BigInt(e.amount);
    if (UP.has(key)) up += amount;
    else if (DOWN.has(key)) down += amount;
    else continue;
    byKind[key] = String(BigInt(byKind[key] ?? 0) + amount);
  }
  const observed = BigInt(issuanceTo) - BigInt(issuanceFrom);
  const explained = up - down;
  return {
    ok: observed === explained,
    observed_delta: String(observed),
    explained_delta: String(explained),
    unexplained: String(observed - explained),
    by_kind: byKind,
  };
}

export function isIssuanceEvent(section, method) {
  const key = `${section}.${method}`;
  return UP.has(key) || DOWN.has(key);
}
