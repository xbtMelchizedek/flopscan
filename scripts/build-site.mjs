#!/usr/bin/env node
// Build the static dashboard from data/v1/latest.json. No client-side script, no fonts, no
// trackers: the page is HTML and CSS, and every number on it comes from the JSON it ships with.
//
//   node scripts/build-site.mjs [--data data/v1] [--out _site]

import { copyFileSync, mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { esc, exactFlop, formatFlop, formatValue, groupDigits } from "../src/format.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const EXPLORER = "https://explorer.devnet.flop.network";
const REPO = "https://github.com/xbtMelchizedek/flopscan";

const GROUPS = [
  ["rewards", "Block rewards", "Scheduled rewards, and what each leg actually minted. Chain events, chain counters, the schedule and the explorer."],
  ["miners", "Miners", "Registered miners, rewards per miner, and liveness probes (synthetic tasks) per miner. Liveness is a proxy for uptime, not a measurement of it."],
  ["compute", "Sessions and settlement", "Compute bought and settled: FLOP paid to miners, settlements, channels and agent session keys."],
  ["verifiers", "Proof verifiers", "Proofs verified per settlement pallet (SP1, Groth16 and others). Blind spot: a proof submitted inside a wrapper call (utility.batch, proxy, sudo, multisig) is indexed under the wrapper and is missed by both sides."],
  ["forward", "Forward compute market", "Forward offers, positions, bids and listings on chain, against forward settlements and term-curve trades in the explorer."],
  ["agents", "Agents", "Agent identities and agent wallets. Identity registrations are checked one by one against their events; the explorer has no identity count, so the total is one source."],
  ["faucet", "Faucet", "The devnet faucet signer's transactions between scans, counted on chain (nonce) and in the explorer (transactions it sent). The explorer does not track this account's balance."],
  ["supply", "Supply and validators", "Total issuance and the active validator set."],
  ["validators", null, null],
  ["versions", "Runtime and releases", "Runtime versions by block, and operator releases checked against the container registry."],
];

const STATUS_TEXT = { match: ["success", "Sources agree"], mismatch: ["danger", "Sources disagree"], pending: ["neutral", "Waiting for a second source"] };
const SOURCE_TEXT = { "rpc.storage": "Chain storage", "rpc.keys": "Chain storage map size", "rpc.events": "Chain events", "rpc.runtime": "Chain runtime version", explorer: "Explorer API", schedule: "Reward schedule", ghcr: "Container registry", "faucet-service": "Faucet service" };

const badge = (status, reason) => { const [tone, text] = reason === "single_source" ? ["neutral", "One source only"] : STATUS_TEXT[status] ?? STATUS_TEXT.pending; return `<span class="badge ${tone}"><span class="badge-dot" aria-hidden="true"></span>${text}</span>`; };
const blockLink = (n) => (n == null ? "" : `<a href="${EXPLORER}/blocks/${n}">${groupDigits(String(n))}</a>`);
const utc = (t) => (t ? `${t.slice(0, 10)} ${t.slice(11, 16)} UTC` : "time unknown");

function readingValue(r, unit) {
  if (r.value === null) return "not read";
  if (unit === "FLOP" && /^-?\d+$/.test(r.value)) return `${esc(exactFlop(r.value))} FLOP`;
  if (unit === "count" && /^-?\d+$/.test(r.value)) return esc(groupDigits(r.value));
  return esc(r.value);
}

function card(m) {
  const shown = formatValue(m.value, m.unit);
  const display = m.display && m.value !== null ? esc(m.display) : shown;
  const unit = m.unit === "FLOP" && shown ? ` <span class="unit">FLOP</span>` : "";
  const value = m.value !== null
    ? `<p class="value"><data value="${esc(m.value)}">${display}</data>${unit}</p>`
    : `<p class="value none">${m.status === "mismatch" ? "No agreed value" : "No value yet"}</p>`;
  const subs = [];
  if (m.status === "mismatch" && m.delta) subs.push(`Off by ${m.unit === "FLOP" ? `${esc(exactFlop(m.delta))} FLOP` : esc(groupDigits(m.delta))}. Every reading is listed below.`);
  if (m.status === "pending" && m.reason === "single_source") subs.push("Only one source exists for this today. Its readings agree with each other and are listed below, but one source is not shown as a number.");
  else if (m.status === "pending") subs.push("Fewer than two sources could be read this run.");
  if (m.method === "rowwise" && m.detail?.disagreements?.length) subs.push(`${esc(String(m.detail.disagreements.length))} row(s) disagree; listed in the JSON.`);
  if (m.value === null && m.last_match) subs.push(`Last agreed: ${esc(formatValue(m.last_match.value, m.unit))}${m.unit === "FLOP" ? " FLOP" : ""} at block ${blockLink(m.last_match.block)}.`);
  if (m.id === "rewards.miner_minted" && m.context?.scheduled_miner_leg && m.value !== null) subs.push(`Of ${esc(formatFlop(m.context.scheduled_miner_leg))} FLOP scheduled for the miner leg.`);
  if (m.window?.hours) subs.push(`Over ${esc(m.window.hours)} h, blocks ${blockLink(m.window.from_block)} to ${blockLink(m.window.to_block)}.`);
  if (m.link) subs.push(`<a href="${esc(m.link)}">Open in explorer</a>`);
  const readings = (m.readings ?? []).map((r) => `<div><dt>${esc(SOURCE_TEXT[r.source] ?? r.source)}${r.context ? ' <span class="ctx">(context, not used for the status)</span>' : ""}${r.label ? `: ${esc(r.label)}` : ""}${r.block != null ? `, block ${blockLink(r.block)}` : ""}</dt><dd>${readingValue(r, m.unit)}</dd></div>`).join("");
  return `<article class="card" id="${esc(m.id)}" aria-labelledby="${esc(m.id)}-t">
<div class="head"><h3 class="title" id="${esc(m.id)}-t">${esc(m.title)}</h3>${badge(m.status, m.reason)}</div>
${value}
${subs.map((s) => `<p class="sub">${s}</p>`).join("\n")}
<details><summary>How this was checked (${esc(m.method ?? "")})</summary>${m.note ? `<p class="sub">${esc(m.note)}</p>` : ""}<dl class="readings">${readings}</dl></details>
</article>`;
}

function cell(col, v, row) {
  if (v === null || v === undefined) return `<td>–</td>`;
  if (col === "status") return `<td>${badge(v)}</td>`;
  if (["miner", "pallet"].includes(col) && row.link) return `<td class="mono"><a href="${esc(row.link)}">${esc(String(v).slice(0, 10))}…${esc(String(v).slice(-6))}</a></td>`;
  if (["block", "from_block", "to_block", "code_updated_block", "first_seen_block"].includes(col)) return `<td class="num">${blockLink(v)}</td>`;
  if (["scheduled", "miner_share", "miner_leg_unminted", "rpc_storage", "rpc_events", "explorer"].includes(col) && /^-?\d+$/.test(String(v))) return `<td class="num">${esc(formatFlop(String(v)))}</td>`;
  if (col === "completion_bps") return `<td class="num">${esc((Number(v) / 100).toFixed(2))}%</td>`;
  if (/^-?\d+$/.test(String(v))) return `<td class="num">${esc(groupDigits(String(v)))}</td>`;
  return `<td>${esc(v)}</td>`;
}

const COL_TEXT = { block: "Block", scheduled: "Scheduled (FLOP)", miner_share: "Miner leg minted (FLOP)", miner_leg_unminted: "Miner leg not minted (FLOP)", miners_paid: "Miners paid", miner: "Miner", rpc_storage: "Chain storage (FLOP)", rpc_events: "Chain events (FLOP)", explorer: "Explorer (FLOP)", status: "Status", issued: "Probes issued", completed: "Completed", completion_bps: "Completion", label: "Verifier", proofs_verified: "Proofs verified", vks: "Keys", tickets: "Tickets", spec_version: "Spec version", from_block: "From block", to_block: "To block", code_updated_block: "CodeUpdated in block", component: "Component", version: "Version", first_seen_block: "First seen at block", first_seen_utc: "First seen" };

function table(t) {
  const numeric = (c) => !["miner", "status", "label", "component", "version", "first_seen_utc"].includes(c);
  const head = t.columns.map((c) => `<th scope="col"${numeric(c) ? ' class="num"' : ""}>${esc(COL_TEXT[c] ?? c)}</th>`).join("");
  const body = t.rows.map((r) => `<tr>${t.columns.map((c) => cell(c, r[c], r)).join("")}</tr>`).join("\n");
  const notes = [t.note, t.summary ? `${t.summary.agreed} of ${t.summary.checked} miners agree between chain and explorer${t.summary.chain_only ? `; ${t.summary.chain_only} more are on chain only` : ""}. Top 50 by probes issued.` : null, ...(t.blind_spots ?? [])].filter(Boolean);
  return `<div class="table-wrap" id="${esc(t.id)}"><table><caption>${esc(t.title)} ${badge(t.status)}${notes.map((n) => `<span class="sub">${esc(n)}</span>`).join("")}</caption><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${t.columns.length}">No rows.</td></tr>`}</tbody></table></div>`;
}

export function renderPage(doc) {
  const by = new Map();
  for (const m of doc.metrics) { const g = m.group === "validators" ? "supply" : m.group; if (!by.has(g)) by.set(g, []); by.get(g).push(m); }
  const sections = GROUPS.filter(([g, title]) => title && by.has(g)).map(([g, title, note]) => {
    const ms = by.get(g);
    const cards = ms.filter((m) => m.kind !== "table");
    const tables = ms.filter((m) => m.kind === "table");
    return `<section aria-labelledby="g-${g}"><h2 id="g-${g}">${esc(title)}</h2><p class="section-note">${esc(note)}</p>
<div class="grid">${cards.map(card).join("\n")}</div>
${tables.map(table).join("\n")}</section>`;
  }).join("\n");
  const s = doc.summary;
  const asOf = doc.as_of;
  const errors = Object.entries(doc.sources?.errors ?? {});
  const toc = GROUPS.filter(([g, title]) => title && by.has(g)).map(([g, title]) => `<a href="#g-${g}">${esc(title)}</a>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'">
<meta name="referrer" content="no-referrer">
<meta name="color-scheme" content="light dark">
<title>flopscan: reconciled FLOP devnet metrics</title>
<meta name="description" content="Read-only FLOP devnet metrics that two independent sources agree on, with the block and time each was read.">
<link rel="stylesheet" href="arc/foundation.css">
<link rel="stylesheet" href="arc/badge.css">
<link rel="stylesheet" href="theme-auto.css">
<link rel="stylesheet" href="app.css">
<link rel="alternate" type="application/json" href="data/v1/latest.json">
</head>
<body>
<a class="skip" href="#main">Skip to the metrics</a>
<div class="wrap">
<header class="top">
<h1>flopscan</h1>
<p class="lede">FLOP devnet numbers that two independent sources agree on: the chain (storage, events, runtime) and the explorer's API. When they disagree, both readings are shown and no number is.</p>
<p class="asof">${asOf ? `As of block ${blockLink(asOf.block)}, ${esc(utc(asOf.time_utc))}.` : "The chain could not be read this run."} Read window: blocks ${blockLink(doc.window?.lo?.block)} to ${blockLink(doc.window?.hi?.block)}. Generated ${esc(utc(doc.generated_at_utc))}.</p>
<ul class="summary" aria-label="Reconciliation summary">
<li><span class="badge success"><span class="badge-dot" aria-hidden="true"></span>${s.match} agree</span></li>
<li><span class="badge danger"><span class="badge-dot" aria-hidden="true"></span>${s.mismatch} disagree</span></li>
<li><span class="badge neutral"><span class="badge-dot" aria-hidden="true"></span>${s.pending} without an agreed value</span></li>
</ul>
<div class="alert" role="note"><strong>Devnet data, not financial information. Unaudited.</strong> Devnet FLOP has no value. This page is read-only: it never signs or sends anything. Unaffiliated with Flop Labs.</div>
${errors.length ? `<div class="alert danger" role="status"><strong>Some sources could not be read this run.</strong> ${errors.map(([k, v]) => `${esc(k)}: ${esc(String(v).split("\n")[0].slice(0, 160))}`).join("; ")} Full messages are in latest.json.</div>` : ""}
<nav class="toc" aria-label="Sections">${toc}</nav>
</header>
<main id="main">
${sections}
</main>
<footer>
<p>Data: <a href="data/v1/latest.json">latest.json</a>, <a href="data/v1/history.json">history.json</a>, <a href="schema/v1.json">JSON schema</a>. Amounts in the JSON are integer planck (1 FLOP = 10<sup>18</sup> planck).</p>
<p>Method, code and tests: <a href="${REPO}">github.com/xbtMelchizedek/flopscan</a> (MIT). Refreshed about every 30 minutes by a scheduled GitHub Actions run.</p>
<p>No cookies, no analytics, no scripts. Styles use Arc's free core, MIT, Copyright (c) 2026 Elia Kuratli (<a href="arc/LICENSE">license</a>).</p>
</footer>
</div>
</body>
</html>
`;
}

/** foundation.css's dark block, re-scoped to the system preference so no script is needed. */
export function autoTheme(foundation, badgeCss) {
  const start = foundation.indexOf(':root[data-theme="dark"] {');
  const end = foundation.indexOf("}", start);
  if (start < 0 || end < 0) throw new Error("foundation.css: dark block not found");
  const body = foundation.slice(foundation.indexOf("{", start) + 1, end);
  const series = /:root\[data-theme="dark"\] \{ (--series-1[^}]+)\}/.exec(foundation)?.[1] ?? "";
  const badgeDark = /:root\[data-theme="dark"\] \.badge \{([^}]+)\}/.exec(badgeCss)?.[1] ?? "";
  return `/* Generated by scripts/build-site.mjs from arc/foundation.css (MIT, Elia Kuratli): the dark theme, applied when the system asks for it. */
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {${body}  ${series}}
  :root:not([data-theme="light"]) .badge {${badgeDark}}
}
`;
}

export function build({ dataDir = join(ROOT, "data/v1"), outDir = join(ROOT, "_site") } = {}) {
  const doc = JSON.parse(readFileSync(join(dataDir, "latest.json"), "utf8"));
  mkdirSync(join(outDir, "arc"), { recursive: true });
  mkdirSync(join(outDir, "data/v1"), { recursive: true });
  mkdirSync(join(outDir, "schema"), { recursive: true });
  for (const f of ["foundation.css", "badge.css", "LICENSE"]) copyFileSync(join(ROOT, "web/arc", f), join(outDir, "arc", f));
  copyFileSync(join(ROOT, "web/app.css"), join(outDir, "app.css"));
  writeFileSync(join(outDir, "theme-auto.css"), autoTheme(readFileSync(join(ROOT, "web/arc/foundation.css"), "utf8"), readFileSync(join(ROOT, "web/arc/badge.css"), "utf8")));
  for (const f of ["latest.json", "history.json"]) if (existsSync(join(dataDir, f))) copyFileSync(join(dataDir, f), join(outDir, "data/v1", f));
  copyFileSync(join(ROOT, "schema/v1.json"), join(outDir, "schema/v1.json"));
  writeFileSync(join(outDir, "index.html"), renderPage(doc));
  writeFileSync(join(outDir, ".nojekyll"), "");
  return outDir;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { values } = parseArgs({ options: { data: { type: "string" }, out: { type: "string" } } });
  const out = build({ dataDir: values.data, outDir: values.out });
  process.stdout.write(`built ${out}\n`);
}
