// diff-partd.js
// Compares the two newest Part D snapshots at the drug level.
//
// CMS assigns new formulary IDs each plan year, so the comparison follows the
// plans rather than the IDs: for every plan present in both snapshots, the
// formulary it used before is compared with the formulary it uses now. Plans
// that made the same before -> after transition are grouped so each comparison
// runs once and is weighted by the number of plans on it.
//
// Outputs (all under data/partd/diffs/):
//   <prev>_to_<latest>.csv            one row per change
//   <prev>_to_<latest>.summary.json   counts and the most widespread changes
//   index.json                        list of diffs produced so far
//
// Change types: ADDED, REMOVED, TIER_UP (worse), TIER_DOWN (better), PA_ADDED,
// PA_REMOVED, ST_ADDED, ST_REMOVED, QL_ADDED, QL_REMOVED, QL_CHANGED,
// SELECTED_DRUG_FLAG_CHANGED, plus PLAN_FORMULARY_SWITCH when, within the same
// plan year, a plan moves to a different formulary ID, and FORMULARY_SPLIT when
// plans that shared one formulary before are now on different formularies.
//
// No npm packages. Node 20 or newer. FORCE=true rebuilds an existing diff.

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

function readCsv(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length);
  const h = parseCsvLine(lines[0]);
  return lines.slice(1).map((l) => { const f = parseCsvLine(l); const o = {}; h.forEach((c, i) => { o[c] = f[i]; }); return o; });
}

async function readFormulary(snap) {
  // Returns Map formulary_id -> Map rxcui -> {tier, pa, st, ql, qlAmt, qlDays, sel}
  const file = path.join(SNAP_DIR, snap, 'formulary.csv.gz');
  const rl = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  let h = null; const idx = {};
  const byForm = new Map();
  for await (const line of rl) {
    if (!h) { h = line.split(','); h.forEach((c, i) => { idx[c] = i; }); continue; }
    if (!line) continue;
    const f = line.split(',');
    const form = f[idx.formulary_id];
    let m = byForm.get(form);
    if (!m) { m = new Map(); byForm.set(form, m); }
    m.set(f[idx.rxcui], {
      tier: f[idx.tier] || '', pa: f[idx.pa] || '', st: f[idx.st] || '', ql: f[idx.ql] || '',
      qlAmt: f[idx.ql_amount] || '', qlDays: f[idx.ql_days] || '', sel: idx.selected_drug != null ? (f[idx.selected_drug] || '') : '',
    });
  }
  return byForm;
}

function tierNum(t) { const n = parseInt(t, 10); return Number.isFinite(n) ? n : null; }
function planKey(p) { return `${p.contract_id}|${p.plan_id}|${p.segment_id}`; }

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
  const plansPrev = readCsv(path.join(SNAP_DIR, prev, 'plans.csv'));
  const plansLatest = readCsv(path.join(SNAP_DIR, latest, 'plans.csv'));
  const formsPrev = readCsv(path.join(SNAP_DIR, prev, 'formularies.csv'));
  const formsLatest = readCsv(path.join(SNAP_DIR, latest, 'formularies.csv'));
  const yearPrev = (formsPrev[0] || {}).contract_year || '';
  const yearLatest = (formsLatest[0] || {}).contract_year || '';
  const newYear = yearPrev !== yearLatest;
  log(`Contract year ${yearPrev} -> ${yearLatest}${newYear ? ' (new plan year: formulary ids are expected to change, following plans instead)' : ''}`);

  // ---- Build transitions: prevFormulary -> latestFormulary, with the plans on each ----
  const prevByPlan = new Map(plansPrev.map((p) => [planKey(p), p]));
  const latestKeys = new Set(plansLatest.map(planKey));
  const transitions = new Map(); // "prevF|latestF" -> {prevF, latestF, plans, parents Map, tickers Set, examples}
  let matchedPlans = 0, newPlans = 0;
  const prevFormToLatest = new Map(); // prevF -> Set(latestF)
  for (const p of plansLatest) {
    const q = prevByPlan.get(planKey(p));
    if (!q) { newPlans++; continue; }
    matchedPlans++;
    const k = `${q.formulary_id}|${p.formulary_id}`;
    let t = transitions.get(k);
    if (!t) { t = { prevF: q.formulary_id, latestF: p.formulary_id, plans: 0, parents: new Map(), tickers: new Set(), examples: [] }; transitions.set(k, t); }
    t.plans++;
    t.parents.set(p.parent, (t.parents.get(p.parent) || 0) + 1);
    if (p.ticker) t.tickers.add(p.ticker);
    if (t.examples.length < 3) t.examples.push(`${p.contract_id}-${p.plan_id} ${p.plan_name}`);
    if (!prevFormToLatest.has(q.formulary_id)) prevFormToLatest.set(q.formulary_id, new Set());
    prevFormToLatest.get(q.formulary_id).add(p.formulary_id);
  }
  const goneP = plansPrev.filter((q) => !latestKeys.has(planKey(q))).length;
  log(`Plans: ${plansPrev.length} before, ${plansLatest.length} now; ${matchedPlans} matched, ${newPlans} new, ${goneP} gone`);
  log(`Distinct formulary transitions to compare: ${transitions.size}`);

  const A = await readFormulary(prev);
  const B = await readFormulary(latest);
  log(`Formularies loaded: ${A.size} before, ${B.size} now`);

  const changes = [];
  function push(t, rxcui, type, detail, before, after) {
    const d = drugs[rxcui] || {};
    const lab = mapLabeler(d.labeler);
    changes.push({
      prev_formulary_id: t.prevF, formulary_id: t.latestF, rxcui, change: type, detail, before, after,
      drug: d.name || '', tty: d.tty || '', ingredients: d.ingredients || '', brands: d.brands || '',
      labeler: d.labeler || '', mfr_parent: lab.parent, mfr_ticker: lab.ticker,
      plan_count: t.plans,
      plan_parents: [...t.parents.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} (${n})`).join('; '),
      plan_tickers: [...t.tickers].sort().join(' '),
      example_plans: t.examples.join('; '),
    });
  }

  // ---- Structural changes ----
  let switches = 0, splits = 0;
  for (const t of transitions.values()) {
    if (!newYear && t.prevF !== t.latestF) { switches++; push(t, '', 'PLAN_FORMULARY_SWITCH', `${t.plans} plan(s) moved to a different formulary id within the plan year`, t.prevF, t.latestF); }
  }
  for (const [prevF, set] of prevFormToLatest) {
    if (set.size > 1) {
      splits++;
      for (const t of transitions.values()) if (t.prevF === prevF) push(t, '', 'FORMULARY_SPLIT', `plans formerly on ${prevF} now sit on ${set.size} different formularies`, prevF, [...set].join(' '));
    }
  }

  // ---- Drug-level changes, once per transition ----
  let compared = 0, skipped = 0;
  for (const t of transitions.values()) {
    const a = A.get(t.prevF); const b = B.get(t.latestF);
    if (!a || !b) { skipped++; continue; }
    compared++;
    for (const [rxcui, y] of b) {
      const x = a.get(rxcui);
      if (!x) { push(t, rxcui, 'ADDED', `tier ${y.tier}${y.pa === 'Y' ? ' PA' : ''}${y.st === 'Y' ? ' ST' : ''}${y.ql === 'Y' ? ' QL' : ''}`, '', y.tier); continue; }
      const ta = tierNum(x.tier), tb = tierNum(y.tier);
      if (x.tier !== y.tier) push(t, rxcui, ta != null && tb != null && tb > ta ? 'TIER_UP' : 'TIER_DOWN', `tier ${x.tier} -> ${y.tier}`, x.tier, y.tier);
      if (x.pa !== y.pa) push(t, rxcui, y.pa === 'Y' ? 'PA_ADDED' : 'PA_REMOVED', 'prior authorization', x.pa, y.pa);
      if (x.st !== y.st) push(t, rxcui, y.st === 'Y' ? 'ST_ADDED' : 'ST_REMOVED', 'step therapy', x.st, y.st);
      if (x.ql !== y.ql) push(t, rxcui, y.ql === 'Y' ? 'QL_ADDED' : 'QL_REMOVED', `quantity limit ${y.qlAmt}/${y.qlDays}d`, x.ql, y.ql);
      else if (y.ql === 'Y' && (x.qlAmt !== y.qlAmt || x.qlDays !== y.qlDays)) push(t, rxcui, 'QL_CHANGED', 'quantity limit amount or days', `${x.qlAmt}/${x.qlDays}d`, `${y.qlAmt}/${y.qlDays}d`);
      if (x.sel !== y.sel) push(t, rxcui, 'SELECTED_DRUG_FLAG_CHANGED', 'Medicare negotiation selected-drug flag', x.sel, y.sel);
    }
    for (const [rxcui, x] of a) if (!b.has(rxcui)) push(t, rxcui, 'REMOVED', `was tier ${x.tier}`, x.tier, '');
  }
  log(`Transitions compared: ${compared}, skipped (formulary missing from a snapshot): ${skipped}`);

  // ---- Write CSV ----
  const cols = ['prev_formulary_id', 'formulary_id', 'rxcui', 'change', 'detail', 'before', 'after', 'drug', 'tty', 'ingredients', 'brands', 'labeler', 'mfr_parent', 'mfr_ticker', 'plan_count', 'plan_parents', 'plan_tickers', 'example_plans'];
  const csv = [cols.join(',')].concat(changes.map((c) => cols.map((k) => csvCell(c[k])).join(',')));
  fs.writeFileSync(path.join(DIFF_DIR, `${tag}.csv`), csv.join('\n') + '\n');

  // ---- Summary ----
  const byType = {};
  for (const c of changes) byType[c.change] = (byType[c.change] || 0) + 1;

  const agg = new Map(); // rxcui|change -> rollup across transitions, weighted by plans
  for (const c of changes) {
    if (!c.rxcui) continue;
    const k = `${c.rxcui}|${c.change}`;
    const x = agg.get(k) || { rxcui: c.rxcui, change: c.change, drug: c.drug, tty: c.tty, ingredients: c.ingredients, labeler: c.labeler, mfr_ticker: c.mfr_ticker, transitions: 0, plans: 0, parents: new Map() };
    x.transitions++;
    x.plans += Number(c.plan_count) || 0;
    for (const part of (c.plan_parents || '').split('; ')) {
      const m = part.match(/^(.*) \((\d+)\)$/);
      if (m) x.parents.set(m[1], (x.parents.get(m[1]) || 0) + Number(m[2]));
    }
    agg.set(k, x);
  }
  const top = [...agg.values()].sort((a, b) => b.plans - a.plans).slice(0, 300)
    .map((x) => ({ ...x, parents: [...x.parents.entries()].sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} (${n})`) }));

  const byParent = {}; // plan parent -> change type -> plans affected
  for (const c of changes) {
    for (const part of (c.plan_parents || '').split('; ')) {
      const m = part.match(/^(.*) \((\d+)\)$/);
      if (!m) continue;
      const x = byParent[m[1]] || (byParent[m[1]] = {});
      x[c.change] = (x[c.change] || 0) + Number(m[2]);
    }
  }
  const byMfr = {}; // manufacturer ticker -> change type -> plans affected
  for (const c of changes) {
    if (!c.mfr_ticker || !c.rxcui) continue;
    const x = byMfr[c.mfr_ticker] || (byMfr[c.mfr_ticker] = { parent: c.mfr_parent });
    x[c.change] = (x[c.change] || 0) + (Number(c.plan_count) || 0);
  }

  const summary = {
    tag, prev, latest, contract_year_prev: yearPrev, contract_year_latest: yearLatest, new_plan_year: newYear,
    generated_at: new Date().toISOString(), plans_matched: matchedPlans, plans_new: newPlans, plans_gone: goneP,
    transitions: transitions.size, transitions_compared: compared, formulary_switches_within_year: switches, formulary_splits: splits,
    total_change_rows: changes.length, by_type: byType, by_plan_parent_plans_affected: byParent, by_manufacturer_plans_affected: byMfr, top_changes: top,
  };
  fs.writeFileSync(path.join(DIFF_DIR, `${tag}.summary.json`), JSON.stringify(summary, null, 2));

  index.diffs = index.diffs.filter((d) => d.tag !== tag);
  index.diffs.push({ tag, prev, latest, total_change_rows: changes.length, generated_at: summary.generated_at });
  index.diffs.sort((a, b) => a.tag.localeCompare(b.tag));
  fs.writeFileSync(INDEX, JSON.stringify(index, null, 2));

  log(`Change rows: ${changes.length.toLocaleString()}; within-year formulary switches: ${switches}; formulary splits: ${splits}`);
  log(`By type: ${JSON.stringify(byType)}`);
  log('Top 30 most widespread drug changes (plans affected):');
  top.slice(0, 30).forEach((x) => log(`   ${String(x.plans).padStart(5)} plans ${String(x.transitions).padStart(4)} formularies  ${x.change.padEnd(10)} ${x.drug} [${x.labeler}] ${x.mfr_ticker}`));
  log('Plans affected by change type, by plan parent (top 12 parents):');
  Object.entries(byParent).sort((a, b) => Object.values(b[1]).reduce((s, v) => s + v, 0) - Object.values(a[1]).reduce((s, v) => s + v, 0)).slice(0, 12)
    .forEach(([p, x]) => log(`   ${p}: ${JSON.stringify(x)}`));
  log(`Wrote ${tag}.csv and ${tag}.summary.json`);
}

main().catch((e) => { console.error('DIFF FAILED:', e.message); process.exit(1); });
