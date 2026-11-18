// Runtime version history by bisection. `probe(n)` returns the spec version at block n; results
// are cached by the caller, so a resumed run re-reads nothing it already knows.
//
// Given versions at lo and hi, if they differ there is at least one boundary in (lo, hi]; split
// until adjacent. If they are equal we assume no change in between. That misses an upgrade that
// was rolled back to the same version between two probes, which the metric note says.

/** Boundaries (first block with a new version) in (lo, hi], ascending. */
export async function findBoundaries(lo, hi, probe) {
  const out = [];
  const vLo = await probe(lo);
  const vHi = await probe(hi);
  const walk = async (a, va, b, vb) => {
    if (va === vb) return;
    if (b - a === 1) { out.push({ block: b, from: va, to: vb }); return; }
    const m = a + Math.floor((b - a) / 2);
    const vm = await probe(m);
    await walk(a, va, m, vm);
    await walk(m, vm, b, vb);
  };
  await walk(lo, vLo, hi, vHi);
  return out;
}

/**
 * Extend cached spans up to `head`. `state` = { checked_to, spans: [{spec_name, spec_version, from_block, to_block, code_updated_block}] }.
 * `probe(n)` -> "name version" string; `codeUpdatedNear(b)` -> block number holding system.CodeUpdated in {b, b-1}, or null.
 */
export async function extendRuntimeHistory(state, head, { probe, codeUpdatedNear, firstBlock = 1 }) {
  const s = state?.spans?.length ? { checked_to: state.checked_to, spans: state.spans.map((x) => ({ ...x })) } : null;
  const from = s ? s.checked_to : firstBlock;
  if (s && head <= from) return s;
  const spans = s ? s.spans : [];
  if (!s) {
    const v0 = await probe(firstBlock);
    const [name, ver] = splitSpec(v0);
    spans.push({ spec_name: name, spec_version: ver, from_block: firstBlock, to_block: firstBlock, code_updated_block: null });
  }
  const bounds = await findBoundaries(from, head, probe);
  for (const b of bounds) {
    spans[spans.length - 1].to_block = b.block - 1;
    const [name, ver] = splitSpec(b.to);
    spans.push({ spec_name: name, spec_version: ver, from_block: b.block, to_block: b.block, code_updated_block: await codeUpdatedNear(b.block) });
  }
  spans[spans.length - 1].to_block = head;
  return { checked_to: head, spans };
}

export function splitSpec(v) {
  const i = v.lastIndexOf(" ");
  return [v.slice(0, i), Number(v.slice(i + 1))];
}
