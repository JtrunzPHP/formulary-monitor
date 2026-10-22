// collect-docs.js
// Phase 2 of the formulary monitor: watches the commercial formulary documents
// listed in sources.js.
//
// For each source on every run:
//   1. Downloads the document and hashes it. Unchanged hash means nothing to do.
//   2. Extracts the text (pdftotext for PDFs, a tag-stripper for HTML pages,
//      xlsx is recorded but not parsed yet).
//   3. Stores the text as data/docs/<id>/<YYYYMMDD-HHMM>.txt and keeps the
//      previous version for comparison.
//   4. Writes a line-level change record (lines added, lines removed) to
//      data/docs/<id>/changes/<stamp>.json.
//   5. Scans the added lines and, on the first capture, the whole document for
//      watchlist names (watchlist.js) and records each hit with surrounding
//      lines of context.
//   6. Updates data/docs/index.json for the dashboard and the email step.
//
// The first run for a source captures a baseline and reports watchlist hits in
// the whole document so the relevant sections can be inspected. Later runs
// report only what changed.
//
// Requires pdftotext (poppler-utils) on the runner; the workflow installs it.
// No npm packages. Node 20 or newer.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { SOURCES } = require('./sources');
const { watchHits, WATCHLIST } = require('./watchlist');

const DATA_DIR = path.join(__dirname, 'data', 'docs');
const INDEX = path.join(DATA_DIR, 'index.json');
const DISCOVERED = path.join(DATA_DIR, 'discovered.json');
const WORK_DIR = path.join(__dirname, '.work-docs');
const KEEP_TEXT_VERSIONS = 6;
const CONTEXT_LINES = 2;
const FORCE = String(process.env.FORCE || '').toLowerCase() === 'true';
const ONLY = (process.env.ONLY || '').trim(); // optional: process a single source id

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2)); }
function stamp() { return new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).replace('T', '-'); }

async function download(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; formulary-monitor; github actions)', 'Accept': '*/*' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return { size: fs.statSync(dest).size, type: res.headers.get('content-type') || '' };
}

function extractText(file, kind) {
  if (kind === 'pdf') {
    const out = file + '.txt';
    execSync(`pdftotext -layout "${file}" "${out}"`, { stdio: 'pipe' });
    return fs.readFileSync(out, 'utf8');
  }
  if (kind === 'html') {
    const html = fs.readFileSync(file, 'utf8');
    return html
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<(br|p|div|li|tr|h\d)[^>]*>/gi, '\n').replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"')
      .split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n');
  }
  if (kind === 'xlsx') return '[xlsx recorded; cell-level parsing is a later step]';
  return fs.readFileSync(file, 'utf8');
}

function slug(s) { return String(s).toLowerCase().replace(/\.(pdf|xlsx|html?)$/i, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60); }

function discoverLinks(html, pageUrl, rule) {
  // Finds links on an index page that match rule.pattern and returns new source entries.
  const out = [];
  const re = /href\s*=\s*["']([^"']+)["']/gi;
  let m;
  const seen = new Set();
  while ((m = re.exec(html))) {
    let href = m[1].replace(/&amp;/g, '&');
    if (!rule.pattern.test(href)) continue;
    let abs;
    try { abs = new URL(href, pageUrl).toString(); } catch { continue; }
    if (seen.has(abs)) continue;
    seen.add(abs);
    const file = path.basename(new URL(abs).pathname);
    const ext = (file.match(/\.(pdf|xlsx|html?)$/i) || [])[1];
    const kind = ext ? ext.toLowerCase().replace('htm', 'html') : (rule.kind || 'pdf');
    out.push({ id: `${rule.idPrefix}${slug(file)}`, pbm: rule.pbm, owner: new URL(abs).hostname, name: `${rule.namePrefix || ''}${file}`, url: abs, kind, cadence: rule.cadence || '', verified: 'discovered', discovered_from: pageUrl });
  }
  return out;
}

function normLines(text) {
  return text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length > 1);
}

function diffLines(oldText, newText) {
  const a = normLines(oldText), b = normLines(newText);
  const countA = new Map(), countB = new Map();
  a.forEach((l) => countA.set(l, (countA.get(l) || 0) + 1));
  b.forEach((l) => countB.set(l, (countB.get(l) || 0) + 1));
  const added = [], removed = [];
  b.forEach((l, i) => { if ((countB.get(l) || 0) > (countA.get(l) || 0)) { added.push({ line: i, text: l }); countB.set(l, countB.get(l) - 1); } });
  a.forEach((l, i) => { if ((countA.get(l) || 0) > (countB.get(l) || 0)) { removed.push({ line: i, text: l }); countA.set(l, countA.get(l) - 1); } });
  return { added, removed, newLines: b };
}

function scanWatchlist(lines, onlyIndexes) {
  const hits = [];
  const idxs = onlyIndexes || lines.map((_, i) => i);
  for (const i of idxs) {
    const h = watchHits(lines[i]);
    if (!h.length) continue;
    hits.push({
      line: i, tickers: [...new Set(h.map((x) => x.ticker).filter(Boolean))], labels: [...new Set(h.map((x) => x.label))],
      text: lines[i],
      context: lines.slice(Math.max(0, i - CONTEXT_LINES), i + CONTEXT_LINES + 1),
    });
  }
  return hits;
}

async function processSource(src, index) {
  const dir = path.join(DATA_DIR, src.id);
  const chDir = path.join(dir, 'changes');
  fs.mkdirSync(chDir, { recursive: true });
  const meta = readJson(path.join(dir, 'meta.json'), { id: src.id, versions: [] });
  const tmp = path.join(WORK_DIR, src.id + '.' + src.kind);

  let dl;
  try { dl = await download(src.url, tmp); }
  catch (e) {
    log(`   FAILED to download: ${e.message}`);
    meta.last_error = { at: new Date().toISOString(), message: e.message };
    writeJson(path.join(dir, 'meta.json'), meta);
    return { id: src.id, status: 'download failed', error: e.message };
  }
  const hash = crypto.createHash('sha256').update(fs.readFileSync(tmp)).digest('hex');
  const last = meta.versions[meta.versions.length - 1];
  if (src.kind === 'html' && src.discover) {
    const found = discoverLinks(fs.readFileSync(tmp, 'utf8'), src.url, src.discover);
    log(`   discovery: ${found.length} link(s) on the page match ${src.discover.pattern}`);
    src.__found = found;
  }
  log(`   downloaded ${(dl.size / 1024).toFixed(0)} KB (${dl.type}); hash ${hash.slice(0, 12)}${last ? ` vs last ${last.hash.slice(0, 12)}` : ' (first capture)'}`);
  if (last && last.hash === hash && !FORCE) {
    meta.last_checked = new Date().toISOString();
    writeJson(path.join(dir, 'meta.json'), meta);
    return { id: src.id, status: 'unchanged', found: src.__found || [] };
  }

  let text;
  try { text = extractText(tmp, src.kind); }
  catch (e) { log(`   FAILED to extract text: ${e.message}`); return { id: src.id, status: 'extract failed', error: e.message }; }
  let st = stamp();
  if (last && last.stamp === st) st = st + 'b';
  const prevText = last ? fs.readFileSync(path.join(dir, `${last.stamp}.txt`), 'utf8') : '';
  fs.writeFileSync(path.join(dir, `${st}.txt`), text);
  const lines = normLines(text);
  log(`   text: ${lines.length} non-empty lines`);

  let change;
  if (last) {
    const d = diffLines(prevText, text);
    const hits = scanWatchlist(d.newLines, d.added.map((x) => x.line));
    const removedHits = d.removed.filter((r) => watchHits(r.text).length).map((r) => ({ line: r.line, text: r.text, tickers: [...new Set(watchHits(r.text).map((h) => h.ticker).filter(Boolean))], labels: [...new Set(watchHits(r.text).map((h) => h.label))] }));
    change = { id: src.id, stamp: st, previous: last.stamp, kind: 'update', lines_added: d.added.length, lines_removed: d.removed.length, added: d.added, removed: d.removed, watchlist_in_added: hits, watchlist_in_removed: removedHits };
    log(`   changed: ${d.added.length} lines added, ${d.removed.length} removed; watchlist hits in added lines: ${hits.length}, in removed lines: ${removedHits.length}`);
  } else {
    const hits = scanWatchlist(lines);
    change = { id: src.id, stamp: st, previous: null, kind: 'baseline', lines_total: lines.length, watchlist_in_document: hits };
    log(`   baseline captured; watchlist hits in document: ${hits.length}`);
  }
  writeJson(path.join(chDir, `${st}.json`), change);

  meta.versions.push({ stamp: st, hash, size: dl.size, captured_at: new Date().toISOString() });
  meta.last_checked = new Date().toISOString();
  delete meta.last_error;
  while (meta.versions.length > KEEP_TEXT_VERSIONS) {
    const old = meta.versions.shift();
    const f = path.join(dir, `${old.stamp}.txt`);
    if (fs.existsSync(f)) fs.rmSync(f);
  }
  writeJson(path.join(dir, 'meta.json'), meta);
  return { id: src.id, status: change.kind, change, found: src.__found || [] };
}

function printHits(title, hits, perLabel = 6) {
  if (!hits || !hits.length) return;
  const groups = new Map();
  for (const h of hits) {
    const key = (h.tickers.join(' ') || '-') + ' ' + h.labels.join('; ');
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(h);
  }
  log(`   ${title} (${hits.length} hits across ${groups.size} watchlist names; up to ${perLabel} shown per name):`);
  for (const [key, list] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    log(`      ${key}  (${list.length})`);
    for (const h of list.slice(0, perLabel)) {
      for (const c of h.context || [h.text]) log(`         | ${c}`);
      log('         |');
    }
  }
}

async function main() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  try { execSync('pdftotext -v', { stdio: 'pipe' }); } catch { log('WARNING: pdftotext not found; PDF sources will fail to extract. The workflow should install poppler-utils.'); }

  const index = readJson(INDEX, { sources: {}, runs: [] });
  const discovered = readJson(DISCOVERED, {});
  const results = [];
  const known = new Set(SOURCES.map((x) => x.url));

  async function runOne(src) {
    log(`Source ${src.id}: ${src.name}`);
    const r = await processSource(src, index);
    results.push(r);
    if (r.change) {
      if (r.change.kind === 'baseline') printHits('Watchlist hits in baseline', r.change.watchlist_in_document);
      else {
        printHits('Watchlist hits in added lines', r.change.watchlist_in_added);
        printHits('Watchlist hits in removed lines', r.change.watchlist_in_removed);
        if (r.change.added.length) { log('   First 15 added lines:'); r.change.added.slice(0, 15).forEach((x) => log(`      + ${x.text}`)); }
        if (r.change.removed.length) { log('   First 15 removed lines:'); r.change.removed.slice(0, 15).forEach((x) => log(`      - ${x.text}`)); }
      }
    }
    for (const f of r.found || []) {
      if (known.has(f.url)) continue;
      known.add(f.url);
      if (!discovered[f.id]) { discovered[f.id] = { ...f, found_at: new Date().toISOString() }; log(`   new document discovered: ${f.id} -> ${f.url}`); }
    }
    const { discover, __found, ...plain } = src;
    index.sources[src.id] = { ...plain, status: r.status, last_checked: new Date().toISOString(), last_change: r.change ? r.change.stamp : (index.sources[src.id] || {}).last_change || null, error: r.error || null };
  }

  for (const src of SOURCES) { if (ONLY && src.id !== ONLY) continue; await runOne(src); }
  writeJson(DISCOVERED, discovered);
  for (const src of Object.values(discovered)) { if (ONLY && src.id !== ONLY) continue; if (!SOURCES.some((x) => x.id === src.id)) await runOne(src); }

  index.runs.push({ at: new Date().toISOString(), results: results.map((r) => ({ id: r.id, status: r.status })) });
  index.runs = index.runs.slice(-60);
  index.watchlist = WATCHLIST.map((w) => ({ ticker: w.ticker, label: w.label }));
  writeJson(INDEX, index);
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  log(`Done. ${results.filter((r) => r.status === 'update').length} updated, ${results.filter((r) => r.status === 'baseline').length} baselined, ${results.filter((r) => r.status === 'unchanged').length} unchanged, ${results.filter((r) => /failed/.test(r.status)).length} failed.`);
}

main().catch((e) => { console.error('COLLECT-DOCS FAILED:', e.message); process.exit(1); });
