import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { autoTheme, build, renderPage } from "../scripts/build-site.mjs";
import { scan } from "../src/scan.mjs";
import { makeWorld } from "./helpers/world.mjs";

const tmp = () => mkdtempSync(join(tmpdir(), "flopscan-"));
async function doc(knobs) {
  const w = makeWorld(knobs); const out = tmp();
  const d = await scan({ outDir: out, cacheDir: tmp(), getJson: w.getJson, connectChain: async () => w.readers, fetchImpl: w.fetchImpl, now: w.now });
  return { d, out };
}

test("page: no scripts, strict CSP, disclaimer, as-of block, explorer links, one h1", async () => {
  const { d } = await doc();
  const html = renderPage(d);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /<iframe|gtag\(|google-analytics|googletagmanager|plausible\.io|hotjar|<img[^>]+https?:/i);
  assert.match(html, /Content-Security-Policy" content="default-src 'none'; style-src 'self'/);
  assert.match(html, /Devnet data, not financial information\. Unaudited\./);
  assert.match(html, /As of block <a href="https:\/\/explorer\.devnet\.flop\.network\/blocks\/1000">1,000<\/a>, 2026-11-18 \d\d:\d\d UTC/);
  assert.equal((html.match(/<h1/g) ?? []).length, 1);
  assert.match(html, /<main id="main">/);
  assert.match(html, /Sources agree/);
});

test("page: a disagreeing metric shows no number, says so, and lists both readings", async () => {
  const { d } = await doc({ minerPaidSkew: 1 });
  const html = renderPage(d);
  const card = html.slice(html.indexOf('id="compute.miner_paid"'), html.indexOf("</article>", html.indexOf('id="compute.miner_paid"')));
  assert.match(card, /Sources disagree/);
  assert.match(card, /No agreed value/);
  assert.doesNotMatch(card, /<data value=/);
  assert.match(card, /Off by 0\.000000000000000001 FLOP/);
  assert.ok((card.match(/<dt>/g) ?? []).length >= 4);
});

test("page: every number shown in a card comes from a matched metric", async () => {
  const { d } = await doc({ minerPaidSkew: 1, httpDown: (p) => p === "/api/stats" });
  const html = renderPage(d);
  const shown = [...html.matchAll(/<article class="card" id="([^"]+)"[\s\S]*?<\/article>/g)].filter((m) => m[0].includes("<data value=")).map((m) => m[1]);
  const matched = new Set(d.metrics.filter((m) => m.status === "match").map((m) => m.id));
  for (const id of shown) assert.ok(matched.has(id), `${id} shows a number without agreement`);
});

test("page: hostile strings from a source are escaped", async () => {
  const { d } = await doc();
  d.metrics[0].title = '<img src=x onerror=alert(1)>';
  d.sources.errors.explorer = "<script>alert(1)</script>";
  const html = renderPage(d);
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /<script>/);
});

test("dark theme follows the system without script, from Arc's own dark block", () => {
  const css = autoTheme(readFileSync(new URL("../web/arc/foundation.css", import.meta.url), "utf8"), readFileSync(new URL("../web/arc/badge.css", import.meta.url), "utf8"));
  assert.match(css, /@media \(prefers-color-scheme: dark\)/);
  assert.match(css, /--background: oklch\(19% 0 0\)/);
  assert.match(css, /\.badge \{ --badge-tint: 12%/);
});

test("build writes the page, the data, the schema, Arc's license and .nojekyll", async () => {
  const { out } = await doc();
  const site = tmp();
  build({ dataDir: out, outDir: site });
  for (const f of ["index.html", "data/v1/latest.json", "data/v1/history.json", "schema/v1.json", "arc/LICENSE", "arc/foundation.css", "theme-auto.css", ".nojekyll"]) assert.ok(existsSync(join(site, f)), f);
  assert.match(readFileSync(join(site, "arc/LICENSE"), "utf8"), /Elia Kuratli/);
});

test("page: a single-source metric says so and shows no number", async () => {
  const { d } = await doc();
  const html = renderPage(d);
  const i = html.indexOf('id="agents.identities"');
  const card = html.slice(i, html.indexOf("</article>", i));
  assert.match(card, /One source only/);
  assert.doesNotMatch(card, /<data value=/);
  assert.doesNotMatch(card, /Sources agree/);
});
