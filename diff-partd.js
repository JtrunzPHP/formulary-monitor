// diff-partd.js
// Compares the two newest Part D snapshots and writes every change at the
// formulary x drug level, enriched with drug name, manufacturer, manufacturer
// ticker, and the plan parents that use the formulary.
//
// Outputs (all under data/partd/diffs/):
//   <prev>_to_<latest>.csv        one row per change
//   <prev>_to_<latest>.summary.json  counts and the most widespread changes
//   index.json                    list of diffs produced so far
//
// Change types: ADDED, REMOVED, TIER_UP (worse), TIER_DOWN (better), PA_ADDED,
// PA_REMOVED, ST_ADDED, ST_REMOVED, QL_ADDED, QL_REMOVED, QL_CHANGED,
// SELECTED_DRUG_FLAG_CHANGED, plus FORMULARY_NEW / FORMULARY_GONE at the
// formulary level and PLAN_FORMULARY_CHANGED when a plan switches formulary.
//
// No npm packages. Node 20 or newer.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { mapLabeler } = require('./labelers');

const DATA_DIR = path.join(__dirname, 'data', 'partd');
const SNAP_DIR = path.join(DATA_DIR, 'snapshots');
const DIFF_DIR = path.join(DATA_DIR, 'diffs');
const DRUGS_JSON = path.join(DATA_DIR, 'drugs.json');
const INDEX = path.join(DIFF_DIR, 'index.json');

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function csvCell(v) { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; }

function parseCsvLine(line) {
  // Handles quoted cells written by csvCell above.
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; }
      else if (ch === '"') q = false;
      else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { out.push(cur); cur = ''; }
    else cur += ch;
  }
  out.push(cur);
  return out;
}

async function readFormulary(snap) {
  const file = path.join(SNAP_DIR, snap, 'formulary.csv.gz');
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let h = null; const idx = {};
  const rows = new Map(); // formulary|rxcui -> {tier, pa, st, ql, qlAmt, qlDays, sel}
  const forms = new Set();
  for await (const line of rl) {
    if (!h) { h = line.split(','); h.forEach((c, i) => { idx[c] = i; }); continue; }
    if (!line) continue;
    const f = line.split(',');
    const form = f[idx.formulary_id];
    forms.add(form);
    rows.set(`${form}|${f[idx.rxcui]}`, {
      tier: f[idx.tier] || '', pa: f[idx.pa] || '', st: f[idx.st] || '', ql: f[idx.ql] || '',
      qlAmt: f[idx.ql_amount] || '', qlDays: f[idx.ql_days] || '', sel: idx.selected_drug != null ? (f[idx.selected_drug] || '') : '',
    });
  }
  return { rows, forms };
}

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length);
  const h = parseCsvLine(lines[0]);
  return lines.slice(1).map((l) => { const f = parseCsvLine(l); const o = {}; h.forEach((c, i) => { o[c] = f[i]; }); return o; });
}

function tierNum(t) { const n = parseInt(t, 10); return Number.isFinite(n) ? n : null; }

async function main() {
  const dirs = fs.existsSync(SNAP_DIR) ? fs.readdirSync(SNAP_DIR).filter((d) => /^\d{8}$/.test(d)).sort() : [];
  if (dirs.length < 2) { log(`Only ${dirs.length} snapshot(s) on disk. A diff needs two. Nothing to do.`); return; }
  const prev = dirs[dirs.length - 2];
  const latest = dirs[dirs.length - 1];
  fs.mkdirSync(DIFF_DIR, { recursive: true });
  const index = readJson(INDEX, { diffs: [] });
  const tag = `${prev}_to_${latest}`;
  if (index.diffs.some((d) => d.tag === tag) && String(process.env.FORCE || '').toLowerCase() !== 'true') {
    log(`Diff ${tag} already exists. Set FORCE=true to rebuild.`); return;
  }
  log(`Diffing ${prev} -> ${latest}`);

  const drugs = readJson(DRUGS_JSON, {});
  const formsLatest = readCsv(path.join(SNAP_DIR, latest, 'formularies.csv'));
  const formsPrev = readCsv(path.join(SNAP_DIR, prev, 'formularies.csv'));
  const formInfo = new Map(formsLatest.map((r) => [r.formulary_id, r]));
  for (const r of formsPrev) if (!formInfo.has(r.formulary_id)) formInfo.set(r.formulary_id, r);

  const plansLatest = readCsv(path.join(SNAP_DIR, latest, 'plans.csv'));
  const plansPrev = readCsv(path.join(SNAP_DIR, prev, 'plans.csv'));
  const yearLatest = (formsLatest[0] || {}).contract_year || '';
  const yearPrev = (formsPrev[0] || {}).contract_year || '';
  log(`Contract year ${yearPrev} -> ${yearLatest}${yearPrev !== yearLatest ? ' (new plan year: expect many changes)' : ''}`);

  const A = await readFormulary(prev);
  const B = await readFormulary(latest);
  log(`Rows: ${A.rows.size.toLocaleString()} -> ${B.rows.size.toLocaleString()}; formularies ${A.forms.size} -> ${B.forms.size}`);

  const changes = [];
  function push(form, rxcui, type, detail, before, after) {
    const d = drugs[rxcui] || {};
    const lab = mapLabeler(d.labeler);
    const fi = formInfo.get(form) || {};
    changes.push({
      formulary_id: form, rxcui, change: type, detail, before, after,
      drug: d.name || '', tty: d.tty || '', ingredients: d.ingredients || '', brands: d.brands || '',
      labeler: d.labeler || '', mfr_parent: lab.parent, mfr_ticker: lab.ticker,
      plan_parents: fi.parents || '', plan_tickers: fi.tickers || '', plan_count: fi.plan_count || '',
    });
  }

  // Formulary-level
  for (const f of B.forms) if (!A.forms.has(f)) push(f, '', 'FORMULARY_NEW', 'formulary id not in previous snapshot', '', '');
  for (const f of A.forms) if (!B.forms.has(f)) push(f, '', 'FORMULARY_GONE', 'formulary id not in latest snapshot', '', '');

  // Plan-level formulary switches
  const planPrev = new Map(plansPrev.map((p) => [`${p.contract_id}|${p.plan_id}|${p.segment_id}`, p]));
  let switched = 0;
  for (const p of plansLatest) {
    const k = `${p.contract_id}|${p.plan_id}|${p.segment_id}`;
    const q = planPrev.get(k);
    if (q && q.formulary_id !== p.formulary_id) {
      switched++;
      push(p.formulary_id, '', 'PLAN_FORMULARY_CHANGED', `${p.contract_id}-${p.plan_id} ${p.plan_name} (${p.parent})`, q.formulary_id, p.formulary_id);
    }
  }

  // Drug-level
  const common = new Set([...A.forms].filter((f) => B.forms.has(f)));
  for (const [key, b] of B.rows) {
    const [form, rxcui] = key.split('|');
    if (!common.has(form)) continue;
    const a = A.rows.get(key);
    if (!a) { push(form, rxcui, 'ADDED', `tier ${b.tier}${b.pa === 'Y' ? ' PA' : ''}${b.st === 'Y' ? ' ST' : ''}${b.ql === 'Y' ? ' QL' : ''}`, '', b.tier); continue; }
    const ta = tierNum(a.tier), tb = tierNum(b.tier);
    if (a.tier !== b.tier) push(form, rxcui, ta != null && tb != null && tb > ta ? 'TIER_UP' : 'TIER_DOWN', `tier ${a.tier} -> ${b.tier}`, a.tier, b.tier);
    if (a.pa !== b.pa) push(form, rxcui, b.pa === 'Y' ? 'PA_ADDED' : 'PA_REMOVED', 'prior authorization', a.pa, b.pa);
    if (a.st !== b.st) push(form, rxcui, b.st === 'Y' ? 'ST_ADDED' : 'ST_REMOVED', 'step therapy', a.st, b.st);
    if (a.ql !== b.ql) push(form, rxcui, b.ql === 'Y' ? 'QL_ADDED' : 'QL_REMOVED', `quantity limit ${b.qlAmt}/${b.qlDays}d`, a.ql, b.ql);
    else if (b.ql === 'Y' && (a.qlAmt !== b.qlAmt || a.qlDays !== b.qlDays)) push(form, rxcui, 'QL_CHANGED', 'quantity limit amount or days', `${a.qlAmt}/${a.qlDays}d`, `${b.qlAmt}/${b.qlDays}d`);
    if (a.sel !== b.sel) push(form, rxcui, 'SELECTED_DRUG_FLAG_CHANGED', 'Medicare negotiation selected-drug flag', a.sel, b.sel);
  }
  for (const [key, a] of A.rows) {
    const [form, rxcui] = key.split('|');
    if (!common.has(form)) continue;
    if (!B.rows.has(key)) push(form, rxcui, 'REMOVED', `was tier ${a.tier}`, a.tier, '');
  }

  // Write CSV
  const cols = ['formulary_id', 'rxcui', 'change', 'detail', 'before', 'after', 'drug', 'tty', 'ingredients', 'brands', 'labeler', 'mfr_parent', 'mfr_ticker', 'plan_parents', 'plan_tickers', 'plan_count'];
  const csv = [cols.join(',')].concat(changes.map((c) => cols.map((k) => csvCell(c[k])).join(',')));
  fs.writeFileSync(path.join(DIFF_DIR, `${tag}.csv`), csv.join('\n') + '\n');

  // Summary
  const byType = {};
  for (const c of changes) byType[c.change] = (byType[c.change] || 0) + 1;

  // Most widespread drug-level changes: same drug and change type across many formularies, weighted by plans
  const agg = new Map();
  for (const c of changes) {
    if (!c.rxcui) continue;
    const k = `${c.rxcui}|${c.change}`;
    const x = agg.get(k) || { rxcui: c.rxcui, change: c.change, drug: c.drug, ingredients: c.ingredients, labeler: c.labeler, mfr_ticker: c.mfr_ticker, formularies: 0, plans: 0, parents: new Set() };
    x.formularies++;
    x.plans += Number(c.plan_count) || 0;
    (c.plan_parents || '').split('; ').filter(Boolean).forEach((p) => x.parents.add(p));
    agg.set(k, x);
  }
  const top = [...agg.values()].sort((a, b) => b.plans - a.plans).slice(0, 200)
    .map((x) => ({ ...x, parents: [...x.parents].sort() }));

  // By plan parent: counts of removals and restrictions
  const byParent = {};
  for (const c of changes) {
    for (const p of (c.plan_parents || '').split('; ').filter(Boolean)) {
      const x = byParent[p] || (byParent[p] = {});
      x[c.change] = (x[c.change] || 0) + 1;
    }
  }

  // By manufacturer ticker: removals and restrictions against them
  const byMfr = {};
  for (const c of changes) {
    if (!c.mfr_ticker) continue;
    const x = byMfr[c.mfr_ticker] || (byMfr[c.mfr_ticker] = { parent: c.mfr_parent });
    x[c.change] = (x[c.change] || 0) + 1;
  }

  const summary = { tag, prev, latest, contract_year_prev: yearPrev, contract_year_latest: yearLatest, generated_at: new Date().toISOString(), total_changes: changes.length, plans_switched_formulary: switched, by_type: byType, by_plan_parent: byParent, by_manufacturer: byMfr, top_changes: top };
  fs.writeFileSync(path.join(DIFF_DIR, `${tag}.summary.json`), JSON.stringify(summary, null, 2));

  index.diffs = index.diffs.filter((d) => d.tag !== tag);
  index.diffs.push({ tag, prev, latest, total_changes: changes.length, generated_at: summary.generated_at });
  index.diffs.sort((a, b) => a.tag.localeCompare(b.tag));
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));

  log(`Changes: ${changes.length.toLocaleString()} total; plans that switched formulary: ${switched}`);
  log(`By type: ${JSON.stringify(byType)}`);
  log('Top 25 most widespread changes (by plans covered):');
  top.slice(0, 25).forEach((x) => log(`   ${String(x.plans).padStart(5)} plans ${String(x.formularies).padStart(4)} formularies  ${x.change.padEnd(10)} ${x.drug} [${x.labeler}] ${x.mfr_ticker}`));
  log(`Wrote ${tag}.csv and ${tag}.summary.json`);
}

main().catch((e) => { console.error('DIFF FAILED:', e.message); process.exit(1); });
