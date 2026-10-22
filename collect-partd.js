// collect-partd.js
// Phase 1 of the formulary monitor: Medicare Part D snapshot collector.
//
// What it does on each run:
//   1. Reads the CMS open-data catalog (data.cms.gov/data.json) and finds the
//      "Monthly Prescription Drug Plan Formulary and Pharmacy Network
//      Information" dataset.
//   2. Picks the newest monthly zip (file names look like 2026_20261015.zip).
//   3. Skips the run if that file was already processed (unless FORCE=true).
//   4. Downloads and unzips it, then reads the Plan Information file and the
//      Basic Drugs Formulary file line by line.
//   5. Tags every plan with its parent company and PBM using parents.js.
//   6. Rolls the formulary up from NDC to RXCUI per formulary and writes a
//      compact snapshot under data/partd/snapshots/<YYYYMMDD>/.
//   7. Writes data/partd/manifest.json and prunes old snapshots.
//
// No npm packages are needed. Node 20 or newer.
//
// The first run prints every file name inside the zip and the header row of
// each file so the column names can be confirmed against the real layout.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { execSync } = require('child_process');
const { mapContract } = require('./parents');

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

const CATALOG_URL = 'https://data.cms.gov/data.json';
const DATASET_TITLE = /^monthly prescription drug plan formulary and pharmacy network information/i;

const DATA_DIR = path.join(__dirname, 'data', 'partd');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const MANIFEST = path.join(DATA_DIR, 'manifest.json');
const WORK_DIR = path.join(__dirname, '.work');

// How many monthly snapshots to keep in the repo. Older ones are deleted from
// the working tree (they stay in git history). Diffs, built in the next step,
// are kept permanently.
const KEEP_SNAPSHOTS = 3;

// Set to true to keep only plans whose parent is mapped in parents.js. False
// keeps every plan in the file and tags the unmapped ones as UNMAPPED.
const KEEP_ONLY_MAPPED = false;

const FORCE = String(process.env.FORCE || '').toLowerCase() === 'true';
const FILE_URL = (process.env.FILE_URL || '').trim();

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function log(...args) {
  console.log(new Date().toISOString().slice(11, 19), ...args);
}

function ensureDir(d) {
  fs.mkdirSync(d, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2));
}

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

function extractDate(name) {
  // Pulls the 8-digit posting date out of names like 2026_20261015.zip or
  // 2025_20241219_Nov2024.zip. Returns '' if none found.
  const m = String(name).match(/_(\d{8})/);
  return m ? m[1] : '';
}

async function fetchJson(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'formulary-monitor (github actions)' } });
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  return res.json();
}

async function downloadFile(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'formulary-monitor (github actions)' } });
  if (!res.ok || !res.body) throw new Error(`Download of ${url} returned ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  const size = fs.statSync(dest).size;
  log(`Downloaded ${(size / 1048576).toFixed(1)} MB to ${path.basename(dest)}`);
}

function listFilesRecursive(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesRecursive(p));
    else out.push(p);
  }
  return out;
}

function findFile(files, pattern) {
  const hits = files.filter((f) => pattern.test(path.basename(f)));
  if (hits.length === 0) return null;
  // Prefer the largest file if several match (full file over sample file).
  hits.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return hits[0];
}

function headerIndex(headerLine) {
  const cols = headerLine.replace(/^\uFEFF/, '').split('|').map((c) => c.trim().toUpperCase());
  const idx = {};
  cols.forEach((c, i) => { idx[c] = i; });
  return { cols, idx };
}

function pick(idx, ...candidates) {
  for (const c of candidates) {
    if (idx[c] != null) return idx[c];
  }
  return -1;
}

// ---------------------------------------------------------------------------
// Step 1: find the newest monthly zip
// ---------------------------------------------------------------------------

async function findLatestZip() {
  if (FILE_URL) {
    log(`Using file_url override: ${FILE_URL}`);
    return { url: FILE_URL, name: path.basename(new URL(FILE_URL).pathname) };
  }

  log(`Reading CMS catalog ${CATALOG_URL}`);
  const catalog = await fetchJson(CATALOG_URL);
  const datasets = Array.isArray(catalog.dataset) ? catalog.dataset : [];
  log(`Catalog lists ${datasets.length} datasets`);

  // CMS publishes each monthly file as its own dataset entry whose title ends
  // with the posting date, e.g. "... Information : 2026-10-15". Collect every
  // zip across all of those entries and pick the newest by date.
  const monthly = datasets.filter((d) => DATASET_TITLE.test(String(d.title || '')));
  log(`Monthly Part D dataset entries found: ${monthly.length}`);
  if (monthly.length === 0) {
    const near = datasets.map((d) => d.title).filter((t) => /formulary/i.test(String(t))).slice(0, 20);
    throw new Error(`No monthly Part D datasets in the catalog. Titles containing "formulary": ${JSON.stringify(near)}`);
  }

  const dists = [];
  for (const ds of monthly) {
    const titleDate = (String(ds.title || '').match(/(\d{4})-(\d{2})-(\d{2})/) || []).slice(1).join('');
    for (const d of ds.distribution || []) {
      const url = d.downloadURL || d.accessURL || '';
      if (!url || !/\.zip(\?|$)/i.test(url)) continue;
      let name = url;
      try { name = path.basename(new URL(url).pathname); } catch {}
      const date = extractDate(name) || titleDate;
      dists.push({ url, name, title: ds.title, date });
    }
  }
  if (dists.length === 0) {
    throw new Error(`Monthly datasets have no zip distributions. Sample entry: ${JSON.stringify(monthly[0]).slice(0, 800)}`);
  }

  dists.sort((a, b) => (b.date || '').localeCompare(a.date || ''));
  log('Newest five monthly zips in the catalog:');
  dists.slice(0, 5).forEach((d) => log(`   ${d.date || '(no date)'}  ${d.name}  ${d.url}`));

  const latest = dists[0];
  if (!latest.date) log('WARNING: could not parse a posting date from the newest entry; proceeding with the first listed.');
  return { url: latest.url, name: latest.name };
}

// ---------------------------------------------------------------------------
// Step 2: parse the Plan Information file
// ---------------------------------------------------------------------------

async function parsePlans(file) {
  log(`Parsing plan information file: ${path.basename(file)}`);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  let header = null;
  let cols = null;
  const plans = new Map(); // key contract|plan|segment
  let lines = 0;

  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!header) {
      ({ cols, idx: header } = headerIndex(line));
      log(`Plan file columns (${cols.length}): ${cols.join(' | ')}`);
      continue;
    }
    if (!line.trim()) continue;
    lines++;
    const f = line.split('|');

    const iContract = pick(header, 'CONTRACT_ID');
    const iPlan = pick(header, 'PLAN_ID');
    const iSeg = pick(header, 'SEGMENT_ID');
    const iCName = pick(header, 'CONTRACT_NAME');
    const iPName = pick(header, 'PLAN_NAME');
    const iForm = pick(header, 'FORMULARY_ID');
    const iSupp = pick(header, 'PLAN_SUPPRESSED_YN');
    const iSnp = pick(header, 'SNP');
    const iState = pick(header, 'STATE');

    if (iContract < 0 || iPlan < 0 || iForm < 0 || iCName < 0) {
      throw new Error(`Plan file is missing a required column. Have: ${cols.join(', ')}`);
    }

    const key = `${f[iContract]}|${f[iPlan]}|${iSeg >= 0 ? f[iSeg] : ''}`;
    let p = plans.get(key);
    if (!p) {
      const m = mapContract(f[iCName]);
      p = {
        contract_id: f[iContract],
        plan_id: f[iPlan],
        segment_id: iSeg >= 0 ? f[iSeg] : '',
        contract_name: f[iCName],
        plan_name: iPName >= 0 ? f[iPName] : '',
        formulary_id: f[iForm],
        suppressed: iSupp >= 0 ? f[iSupp] : '',
        snp: iSnp >= 0 ? f[iSnp] : '',
        states: new Set(),
        parent: m.parent,
        ticker: m.ticker,
        pbm: m.pbm,
      };
      plans.set(key, p);
    }
    if (iState >= 0 && f[iState]) p.states.add(f[iState]);
  }

  log(`Plan file: ${lines} rows, ${plans.size} distinct plans`);
  return plans;
}

// ---------------------------------------------------------------------------
// Step 3: parse the Basic Drugs Formulary file, rolled up to RXCUI
// ---------------------------------------------------------------------------

async function parseFormulary(file, keepFormularies) {
  log(`Parsing formulary file: ${path.basename(file)} (${(fs.statSync(file).size / 1048576).toFixed(0)} MB)`);
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });

  let header = null;
  let cols = null;
  let idx = null;
  const rows = new Map(); // key formulary|rxcui -> [tier, pa, st, ql, qlAmt, qlDays, ndcCount, mixed, selected, ndc]
  const formularyVersions = new Map(); // formulary_id -> "year|version"
  let lines = 0;
  let kept = 0;
  let skippedFormulary = 0;
  const ndcSample = [];

  for await (const raw of rl) {
    const line = raw.replace(/\r$/, '');
    if (!header) {
      ({ cols, idx: header } = headerIndex(line));
      log(`Formulary file columns (${cols.length}): ${cols.join(' | ')}`);
      idx = {
        form: pick(header, 'FORMULARY_ID'),
        rxcui: pick(header, 'RXCUI'),
        ndc: pick(header, 'NDC'),
        tier: pick(header, 'TIER_LEVEL_VALUE', 'TIER'),
        pa: pick(header, 'PRIOR_AUTHORIZATION_YN', 'PA_YN'),
        st: pick(header, 'STEP_THERAPY_YN', 'ST_YN'),
        ql: pick(header, 'QUANTITY_LIMIT_YN', 'QL_YN'),
        qlAmt: pick(header, 'QUANTITY_LIMIT_AMOUNT'),
        qlDays: pick(header, 'QUANTITY_LIMIT_DAYS'),
        selected: pick(header, 'SELECTED_DRUG_YN'),
        version: pick(header, 'FORMULARY_VERSION'),
        year: pick(header, 'CONTRACT_YEAR'),
      };
      log(`Column mapping: ${JSON.stringify(idx)}`);
      if (idx.form < 0 || idx.rxcui < 0 || idx.tier < 0) {
        throw new Error('Formulary file is missing FORMULARY_ID, RXCUI or TIER_LEVEL_VALUE. See the column list above.');
      }
      continue;
    }
    if (!line.trim()) continue;
    lines++;
    if (lines % 1000000 === 0) log(`   ...${lines.toLocaleString()} rows read, ${rows.size.toLocaleString()} formulary-RXCUI keys`);

    const f = line.split('|');
    const form = f[idx.form];
    if (keepFormularies && !keepFormularies.has(form)) { skippedFormulary++; continue; }

    const rxcui = f[idx.rxcui];
    const key = `${form}|${rxcui}`;
    const tier = f[idx.tier] || '';
    const pa = idx.pa >= 0 ? (f[idx.pa] || '') : '';
    const st = idx.st >= 0 ? (f[idx.st] || '') : '';
    const ql = idx.ql >= 0 ? (f[idx.ql] || '') : '';
    const qlAmt = idx.qlAmt >= 0 ? (f[idx.qlAmt] || '') : '';
    const qlDays = idx.qlDays >= 0 ? (f[idx.qlDays] || '') : '';
    const selected = idx.selected >= 0 ? (f[idx.selected] || '') : '';
    const ndc = idx.ndc >= 0 ? (f[idx.ndc] || '') : '';
    if (idx.version >= 0 && !formularyVersions.has(form)) formularyVersions.set(form, `${idx.year >= 0 ? f[idx.year] : ''}|${f[idx.version]}`);

    if (ndcSample.length < 5 && idx.ndc >= 0) ndcSample.push(f[idx.ndc]);

    const existing = rows.get(key);
    if (!existing) {
      rows.set(key, [tier, pa, st, ql, qlAmt, qlDays, 1, 0, selected, ndc]);
      kept++;
    } else {
      existing[6]++;
      if (existing[0] !== tier || existing[1] !== pa || existing[2] !== st || existing[3] !== ql) existing[7] = 1;
    }
  }

  log(`Formulary file: ${lines.toLocaleString()} NDC rows read, ${rows.size.toLocaleString()} formulary-RXCUI combinations kept, ${skippedFormulary.toLocaleString()} rows skipped by formulary filter`);
  log(`Sample NDC values (to confirm format for the name lookup step): ${ndcSample.join(', ')}`);
  return { rows, formularyVersions };
}

// ---------------------------------------------------------------------------
// Step 4: write the snapshot
// ---------------------------------------------------------------------------

function writeSnapshot(dateTag, sourceName, plans, rows, formularyVersions) {
  const dir = path.join(SNAP_DIR, dateTag);
  ensureDir(dir);

  // plans.csv
  const planLines = ['contract_id,plan_id,segment_id,contract_name,plan_name,formulary_id,snp,suppressed,states,parent,ticker,pbm'];
  for (const p of plans.values()) {
    planLines.push([
      p.contract_id, p.plan_id, p.segment_id, p.contract_name, p.plan_name, p.formulary_id,
      p.snp, p.suppressed, [...p.states].sort().join(' '), p.parent, p.ticker, p.pbm,
    ].map(csvCell).join(','));
  }
  fs.writeFileSync(path.join(dir, 'plans.csv'), planLines.join('\n') + '\n');

  // formularies.csv: which parents use each formulary, and how many plans
  const byForm = new Map();
  for (const p of plans.values()) {
    let x = byForm.get(p.formulary_id);
    if (!x) { x = { plans: 0, parents: new Set(), tickers: new Set(), contracts: new Set() }; byForm.set(p.formulary_id, x); }
    x.plans++;
    x.parents.add(p.parent);
    if (p.ticker) x.tickers.add(p.ticker);
    x.contracts.add(p.contract_id);
  }
  const formLines = ['formulary_id,contract_year,formulary_version,plan_count,contract_count,parents,tickers'];
  for (const [fid, x] of byForm) {
    const [yr, ver] = (formularyVersions.get(fid) || '|').split('|');
    formLines.push([fid, yr, ver, x.plans, x.contracts.size, [...x.parents].sort().join('; '), [...x.tickers].sort().join(' ')].map(csvCell).join(','));
  }
  fs.writeFileSync(path.join(dir, 'formularies.csv'), formLines.join('\n') + '\n');

  // formulary.csv.gz: one row per formulary x RXCUI
  const out = ['formulary_id,rxcui,ndc,tier,pa,st,ql,ql_amount,ql_days,selected_drug,ndc_count,mixed_ndc'];
  for (const [key, v] of rows) {
    const [form, rxcui] = key.split('|');
    out.push(`${form},${rxcui},${v[9]},${v[0]},${v[1]},${v[2]},${v[3]},${v[4]},${v[5]},${v[8]},${v[6]},${v[7]}`);
  }
  const gz = zlib.gzipSync(Buffer.from(out.join('\n') + '\n'), { level: 9 });
  fs.writeFileSync(path.join(dir, 'formulary.csv.gz'), gz);

  const meta = {
    snapshot: dateTag,
    source_file: sourceName,
    processed_at: new Date().toISOString(),
    plans: plans.size,
    formularies: byForm.size,
    formulary_rxcui_rows: rows.size,
    formulary_gz_bytes: gz.length,
  };
  writeJson(path.join(dir, 'meta.json'), meta);
  log(`Snapshot written: ${dir}`);
  log(`   plans.csv ${plans.size} plans, formularies.csv ${byForm.size} formularies, formulary.csv.gz ${(gz.length / 1048576).toFixed(1)} MB`);
  return meta;
}

function summarize(plans) {
  const byParent = new Map();
  const unmapped = new Map();
  for (const p of plans.values()) {
    const k = p.parent;
    const x = byParent.get(k) || { plans: 0, formularies: new Set(), names: new Map() };
    x.plans++;
    x.formularies.add(p.formulary_id);
    x.names.set(p.contract_name, (x.names.get(p.contract_name) || 0) + 1);
    byParent.set(k, x);
    if (p.parent === 'UNMAPPED') unmapped.set(p.contract_name, (unmapped.get(p.contract_name) || 0) + 1);
  }
  log('Plans and formularies by parent:');
  [...byParent.entries()]
    .sort((a, b) => b[1].plans - a[1].plans)
    .forEach(([k, x]) => log(`   ${String(x.plans).padStart(5)} plans  ${String(x.formularies.size).padStart(4)} formularies  ${k}`));

  log('Contract names matched under each parent (plan counts), for checking the map:');
  for (const [k, x] of [...byParent.entries()].sort((a, b) => b[1].plans - a[1].plans)) {
    if (k === 'UNMAPPED') continue;
    log(`   ${k}`);
    [...x.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([n, c]) => log(`        ${String(c).padStart(4)}  ${n}`));
  }

  const un = [...unmapped.entries()].sort((a, b) => b[1] - a[1]);
  log(`UNMAPPED contract names (${un.length} distinct). Top 60, paste these back so parents.js can be extended:`);
  un.slice(0, 60).forEach(([n, c]) => log(`   ${String(c).padStart(4)}  ${n}`));
  return un;
}

function pruneSnapshots() {
  if (!fs.existsSync(SNAP_DIR)) return;
  const dirs = fs.readdirSync(SNAP_DIR).filter((d) => /^\d{8}$/.test(d)).sort();
  while (dirs.length > KEEP_SNAPSHOTS) {
    const old = dirs.shift();
    fs.rmSync(path.join(SNAP_DIR, old), { recursive: true, force: true });
    log(`Pruned old snapshot ${old} (still available in git history)`);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  ensureDir(DATA_DIR);
  ensureDir(SNAP_DIR);
  const manifest = readJson(MANIFEST, { latest: null, processed: [] });

  const { url, name } = await findLatestZip();
  const dateTag = extractDate(name) || new Date().toISOString().slice(0, 10).replace(/-/g, '');
  log(`Target file: ${name} (posting date ${dateTag})`);

  if (!FORCE && manifest.processed.some((p) => p.source_file === name)) {
    log(`Already processed ${name}. Nothing to do. (Run with force=true to re-process.)`);
    return;
  }

  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  ensureDir(WORK_DIR);
  const zipPath = path.join(WORK_DIR, name);
  await downloadFile(url, zipPath);

  const unzipDir = path.join(WORK_DIR, 'unzipped');
  ensureDir(unzipDir);
  execSync(`unzip -o -q "${zipPath}" -d "${unzipDir}"`, { stdio: 'inherit' });

  let files = listFilesRecursive(unzipDir);
  log(`Files inside the zip (${files.length}):`);
  files.forEach((f) => log(`   ${(fs.statSync(f).size / 1048576).toFixed(1).padStart(8)} MB  ${path.relative(unzipDir, f)}`));

  // Print the readme if there is one, since it describes the file layout.
  const readme = files.find((f) => /readme\.txt$/i.test(f));
  if (readme) {
    log('---- readme.txt from the zip ----');
    console.log(fs.readFileSync(readme, 'utf8').slice(0, 6000));
    log('---- end readme ----');
  }

  // The monthly zip holds one inner zip per file. Unzip only the two we need
  // (the pharmacy network zips are 2 GB and are not used here).
  const innerDir = path.join(WORK_DIR, 'inner');
  ensureDir(innerDir);
  const innerPlan = findFile(files.filter((f) => /\.zip$/i.test(f)), /plan.*information/i);
  const innerForm = findFile(files.filter((f) => /\.zip$/i.test(f)), /basic.*drugs.*formulary/i);
  for (const z of [innerPlan, innerForm]) {
    if (!z) continue;
    log(`Unzipping inner file ${path.basename(z)}`);
    execSync(`unzip -o -q "${z}" -d "${innerDir}"`, { stdio: 'inherit' });
  }
  const innerFiles = listFilesRecursive(innerDir);
  log(`Files produced by the inner unzip (${innerFiles.length}):`);
  innerFiles.forEach((f) => log(`   ${(fs.statSync(f).size / 1048576).toFixed(1).padStart(8)} MB  ${path.relative(innerDir, f)}`));
  const textFiles = innerFiles.filter((f) => !/\.zip$/i.test(f));

  const planFile = findFile(textFiles, /plan.*information/i);
  const formFile = findFile(textFiles, /basic.*drugs.*formulary/i);
  if (!planFile || !formFile) {
    throw new Error('Could not locate the plan information text file or the basic drugs formulary text file after unzipping. Names above need a pattern update.');
  }

  const plans = await parsePlans(planFile);
  const unmapped = summarize(plans);

  let keepFormularies = null;
  if (KEEP_ONLY_MAPPED) {
    keepFormularies = new Set();
    for (const p of plans.values()) if (p.parent !== 'UNMAPPED') keepFormularies.add(p.formulary_id);
    log(`KEEP_ONLY_MAPPED is on: keeping ${keepFormularies.size} formularies used by mapped parents`);
  }

  const { rows, formularyVersions } = await parseFormulary(formFile, keepFormularies);
  const meta = writeSnapshot(dateTag, name, plans, rows, formularyVersions);

  // Save the unmapped list as a file too, for the mapping pass.
  fs.writeFileSync(
    path.join(DATA_DIR, 'unmapped-contracts.csv'),
    'contract_name,plan_count\n' + unmapped.map(([n, c]) => `${csvCell(n)},${c}`).join('\n') + '\n'
  );

  manifest.processed = manifest.processed.filter((p) => p.source_file !== name);
  manifest.processed.push(meta);
  manifest.processed.sort((a, b) => a.snapshot.localeCompare(b.snapshot));
  manifest.latest = manifest.processed[manifest.processed.length - 1].snapshot;
  writeJson(MANIFEST, manifest);

  pruneSnapshots();
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  log('Done.');
}

main().catch((err) => {
  console.error('COLLECTOR FAILED:', err.message);
  process.exit(1);
});
