// build-drugs.js
// Builds and maintains the drug dictionary used by every later step.
//
// For every distinct RXCUI in the newest Part D snapshot it records:
//   name, term type (brand vs generic), ingredient(s), brand name(s)   from RxNorm
//   proprietary name, generic name, dosage form, route, labeler (manufacturer)
//                                                                   from the FDA NDC directory
//
// Results are cached in data/partd/drugs.json so only codes not seen before are
// looked up on later runs. Also writes:
//   data/partd/drugs.csv              the full dictionary, readable in Excel
//   data/partd/unmapped-labelers.csv  distinct manufacturer names with drug counts,
//                                     the seed list for the ticker map
//
// No npm packages. Node 20 or newer. Set FORCE_REFRESH=true to re-look-up everything.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { execSync } = require('child_process');

const DATA_DIR = path.join(__dirname, 'data', 'partd');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const MANIFEST = path.join(DATA_DIR, 'manifest.json');
const DRUGS_JSON = path.join(DATA_DIR, 'drugs.json');
const DRUGS_CSV = path.join(DATA_DIR, 'drugs.csv');
const LABELERS_CSV = path.join(DATA_DIR, 'unmapped-labelers.csv');
const WORK_DIR = path.join(__dirname, '.work-drugs');

const RXNORM_BASE = 'https://rxnav.nlm.nih.gov/REST';
const FDA_NDC_ZIP = 'https://www.accessdata.fda.gov/cder/ndctext.zip';

const CONCURRENCY = 6;          // parallel RxNorm requests (RxNav asks for no more than 20 per second)
const PAUSE_MS = 60;            // small pause between requests per worker
const FORCE_REFRESH = String(process.env.FORCE_REFRESH || '').toLowerCase() === 'true';

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Read the newest snapshot and collect distinct RXCUI -> representative NDC
// ---------------------------------------------------------------------------

async function readSnapshotCodes() {
  const manifest = readJson(MANIFEST, null);
  if (!manifest || !manifest.latest) throw new Error('No snapshot yet. Run the Part D collector first.');
  const file = path.join(SNAP_DIR, manifest.latest, 'formulary.csv.gz');
  log(`Reading snapshot ${manifest.latest}`);

  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let header = null;
  const codes = new Map(); // rxcui -> ndc
  for await (const line of rl) {
    if (!header) { header = line.split(','); continue; }
    if (!line) continue;
    const f = line.split(',');
    const rxcui = f[header.indexOf('rxcui')];
    const ndc = header.indexOf('ndc') >= 0 ? f[header.indexOf('ndc')] : '';
    if (rxcui && !codes.has(rxcui)) codes.set(rxcui, ndc);
  }
  log(`Distinct RXCUIs in snapshot: ${codes.size}`);
  log(`Snapshot header: ${header.join(',')}`);
  if (header.indexOf('ndc') < 0) log('WARNING: snapshot has no ndc column. Re-run the collector with force=true so the snapshot carries NDCs.');
  log(`Sample snapshot NDC values: ${[...codes.values()].slice(0, 5).map((v) => JSON.stringify(v)).join(', ')}`);
  return codes;
}

// ---------------------------------------------------------------------------
// FDA NDC directory: product-level file keyed by 9-digit labeler+product code
// ---------------------------------------------------------------------------

async function loadFdaNdc() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const zipPath = path.join(WORK_DIR, 'ndctext.zip');
  log(`Downloading FDA NDC directory ${FDA_NDC_ZIP}`);
  const res = await fetch(FDA_NDC_ZIP, { headers: { 'User-Agent': 'formulary-monitor (github actions)' } });
  if (!res.ok || !res.body) throw new Error(`FDA NDC download returned ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(zipPath));
  log(`Downloaded ${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB`);
  execSync(`unzip -o -q "${zipPath}" -d "${WORK_DIR}"`, { stdio: 'inherit' });

  const files = fs.readdirSync(WORK_DIR);
  log(`FDA zip contents: ${files.join(', ')}`);
  const productFile = files.find((f) => /^product\.txt$/i.test(f));
  if (!productFile) throw new Error('product.txt not found in the FDA NDC zip');

  const rl = readline.createInterface({ input: fs.createReadStream(path.join(WORK_DIR, productFile)), crlfDelay: Infinity });
  let idx = null;
  const map = new Map(); // "LLLLL-PPPP" (zero padded) -> record
  let rows = 0;
  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!idx) {
      const cols = line.replace(/^\uFEFF/, '').split('\t').map((c) => c.trim().toUpperCase());
      log(`FDA product.txt columns (${cols.length}): ${cols.join(' | ')}`);
      idx = {};
      cols.forEach((c, i) => { idx[c] = i; });
      for (const need of ['PRODUCTNDC', 'PROPRIETARYNAME', 'NONPROPRIETARYNAME', 'LABELERNAME']) {
        if (idx[need] == null) throw new Error(`FDA product.txt is missing column ${need}`);
      }
      continue;
    }
    if (!line) continue;
    rows++;
    const f = line.split('\t');
    const ndc = f[idx.PRODUCTNDC] || '';
    const m = ndc.match(/^(\d{4,5})-(\d{3,4})$/);
    if (!m) continue;
    const key = m[1].padStart(5, '0') + '-' + m[2].padStart(4, '0');
    if (!map.has(key)) {
      map.set(key, {
        fda_brand: f[idx.PROPRIETARYNAME] || '',
        fda_generic: f[idx.NONPROPRIETARYNAME] || '',
        dosage_form: idx.DOSAGEFORMNAME != null ? (f[idx.DOSAGEFORMNAME] || '') : '',
        route: idx.ROUTENAME != null ? (f[idx.ROUTENAME] || '') : '',
        labeler: f[idx.LABELERNAME] || '',
        marketing_category: idx.MARKETINGCATEGORYNAME != null ? (f[idx.MARKETINGCATEGORYNAME] || '') : '',
        product_type: idx.PRODUCTTYPENAME != null ? (f[idx.PRODUCTTYPENAME] || '') : '',
      });
    }
  }
  log(`FDA product.txt: ${rows} rows, ${map.size} distinct product codes`);
  log(`Sample FDA keys: ${[...map.keys()].slice(0, 5).join(', ')}`);
  return map;
}

function fdaKeyFromCmsNdc(ndc11) {
  // CMS NDC is 11 digits: 5 labeler + 4 product + 2 package.
  const s = String(ndc11 || '').replace(/\D/g, '');
  if (s.length !== 11) return null;
  return s.slice(0, 5) + '-' + s.slice(5, 9);
}

// ---------------------------------------------------------------------------
// RxNorm lookups
// ---------------------------------------------------------------------------

async function rxGet(url) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'formulary-monitor (github actions)' } });
      if (res.status === 404) return null;
      if (res.status === 429 || res.status >= 500) { await sleep(1500 * attempt); continue; }
      if (!res.ok) return null;
      return await res.json();
    } catch {
      await sleep(1000 * attempt);
    }
  }
  return null;
}

async function lookupRxcui(rxcui) {
  const out = { name: '', tty: '', ingredients: '', brands: '', rx_status: '' };
  const props = await rxGet(`${RXNORM_BASE}/rxcui/${rxcui}/properties.json`);
  if (props && props.properties) {
    out.name = props.properties.name || '';
    out.tty = props.properties.tty || '';
    out.rx_status = 'ok';
  } else {
    out.rx_status = 'not found';
    return out;
  }
  await sleep(PAUSE_MS);
  const rel = await rxGet(`${RXNORM_BASE}/rxcui/${rxcui}/related.json?tty=IN+MIN+BN`);
  if (rel && rel.relatedGroup && Array.isArray(rel.relatedGroup.conceptGroup)) {
    const ins = []; const bns = [];
    for (const g of rel.relatedGroup.conceptGroup) {
      for (const c of g.conceptProperties || []) {
        if (g.tty === 'IN' || g.tty === 'MIN') ins.push(c.name);
        if (g.tty === 'BN') bns.push(c.name);
      }
    }
    out.ingredients = [...new Set(ins)].join('; ');
    out.brands = [...new Set(bns)].join('; ');
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const codes = await readSnapshotCodes();
  const drugs = FORCE_REFRESH ? {} : readJson(DRUGS_JSON, {});
  const todo = [...codes.keys()].filter((r) => !drugs[r] || !drugs[r].name);
  log(`Already cached: ${Object.keys(drugs).length}. To look up now: ${todo.length}`);

  const fda = await loadFdaNdc();

  // RxNorm lookups with a small worker pool
  let done = 0; let notFound = 0;
  const queue = [...todo];
  async function worker() {
    while (queue.length) {
      const rxcui = queue.shift();
      const r = await lookupRxcui(rxcui);
      if (r.rx_status !== 'ok') notFound++;
      drugs[rxcui] = Object.assign(drugs[rxcui] || {}, r, { rxcui, updated: new Date().toISOString().slice(0, 10) });
      done++;
      if (done % 500 === 0) log(`   ...${done}/${todo.length} RxNorm lookups done (${notFound} not found)`);
      await sleep(PAUSE_MS);
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  log(`RxNorm lookups complete: ${done} done, ${notFound} not found in RxNorm`);

  // FDA enrichment for every code. First try the NDC in the CMS file; if that
  // misses, ask RxNorm for every NDC tied to the RXCUI and try each (cached).
  let fdaHit = 0; let fdaViaRx = 0; let fdaMiss = 0; let sampleMiss = [];
  const missQueue = [];
  for (const [rxcui, ndc] of codes) {
    const d = drugs[rxcui] || (drugs[rxcui] = { rxcui });
    d.ndc = ndc;
    const key = fdaKeyFromCmsNdc(ndc);
    const rec = key ? fda.get(key) : null;
    if (rec) { Object.assign(d, rec); d.fda_source = 'cms ndc'; fdaHit++; }
    else missQueue.push(rxcui);
  }
  log(`FDA direct NDC match: ${fdaHit} matched, ${missQueue.length} to retry via RxNorm NDC lists`);

  async function ndcWorker() {
    while (missQueue.length) {
      const rxcui = missQueue.shift();
      const d = drugs[rxcui];
      if (!Array.isArray(d.rx_ndcs)) {
        const j = await rxGet(`${RXNORM_BASE}/rxcui/${rxcui}/ndcs.json`);
        d.rx_ndcs = (j && j.ndcGroup && j.ndcGroup.ndcList && j.ndcGroup.ndcList.ndc) || [];
        await sleep(PAUSE_MS);
      }
      let found = null;
      for (const n of d.rx_ndcs) {
        const k = fdaKeyFromCmsNdc(n);
        if (k && fda.has(k)) { found = fda.get(k); break; }
      }
      if (found) { Object.assign(d, found); d.fda_source = 'rxnorm ndc'; fdaViaRx++; }
      else { fdaMiss++; if (!d.labeler) d.labeler = ''; if (sampleMiss.length < 10) sampleMiss.push(`${rxcui} ${d.name} cms:${d.ndc} rx:${d.rx_ndcs.slice(0, 3).join('/')}`); }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, ndcWorker));
  for (const rxcui of codes.keys()) { const d = drugs[rxcui]; if (!d.name && d.fda_brand) d.name = d.fda_brand; }
  log(`FDA NDC match: ${fdaHit} direct, ${fdaViaRx} via RxNorm NDC list, ${fdaMiss} not matched`);
  if (sampleMiss.length) { log('Sample unmatched:'); sampleMiss.forEach((s) => log(`   ${s}`)); }

  fs.writeFileSync(DRUGS_JSON, JSON.stringify(drugs, null, 1));

  const cols = ['rxcui', 'name', 'tty', 'ingredients', 'brands', 'ndc', 'fda_brand', 'fda_generic', 'dosage_form', 'route', 'labeler', 'marketing_category', 'product_type', 'fda_source', 'rx_status', 'updated'];
  const lines = [cols.join(',')];
  for (const rxcui of [...codes.keys()].sort((a, b) => Number(a) - Number(b))) {
    const d = drugs[rxcui] || {};
    lines.push(cols.map((c) => csvCell(d[c])).join(','));
  }
  fs.writeFileSync(DRUGS_CSV, lines.join('\n') + '\n');

  // Labeler seed list for the ticker map
  const labelers = new Map();
  for (const rxcui of codes.keys()) {
    const l = (drugs[rxcui] && drugs[rxcui].labeler) || '(no FDA match)';
    labelers.set(l, (labelers.get(l) || 0) + 1);
  }
  const lab = [...labelers.entries()].sort((a, b) => b[1] - a[1]);
  fs.writeFileSync(LABELERS_CSV, 'labeler,drug_count\n' + lab.map(([n, c]) => `${csvCell(n)},${c}`).join('\n') + '\n');
  log(`Distinct labelers: ${lab.length}. Top 40:`);
  lab.slice(0, 40).forEach(([n, c]) => log(`   ${String(c).padStart(5)}  ${n}`));

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  log(`Wrote ${DRUGS_JSON}, ${DRUGS_CSV}, ${LABELERS_CSV}. Done.`);
}

main().catch((e) => { console.error('BUILD-DRUGS FAILED:', e.message); process.exit(1); });
