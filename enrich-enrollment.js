// enrich-enrollment.js
// Downloads CMS "Monthly Enrollment by Plan" (the newest month available) and
// writes data/partd/enrollment.json: one entry per contract and plan with the
// enrollment count and CMS's own parent organization name.
//
// The diff uses it to weight every change by covered lives instead of plan
// counts, and the log compares CMS's parent organization with parents.js so
// the map can be corrected where they disagree.
//
// Enrollment under 11 is masked by CMS ("*"); those plans count as 0 lives and
// are flagged in the file so totals are understood as slightly understated.
//
// No npm packages. Node 20 or newer. Set ENROLLMENT_URL to override the file.

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { pipeline } = require('stream/promises');
const { Readable } = require('stream');
const { mapContract } = require('./parents');

const DATA_DIR = path.join(__dirname, 'data', 'partd');
const OUT = path.join(DATA_DIR, 'enrollment.json');
const WORK = path.join(__dirname, '.work-enroll');
const OVERRIDE = (process.env.ENROLLMENT_URL || '').trim();

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }

function monthUrl(y, m) { return `https://www.cms.gov/files/zip/monthly-report-plan-${y}-${String(m).padStart(2, '0')}-zip.zip`; }

async function tryDownload(url, dest) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0 (compatible; formulary-monitor)' }, redirect: 'follow' });
  if (!res.ok || !res.body) return false;
  const type = res.headers.get('content-type') || '';
  if (!/zip|octet/.test(type)) { log(`   ${url} returned ${res.status} ${type}, not a zip`); return false; }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
  return true;
}

function parseCsvLine(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

async function main() {
  fs.rmSync(WORK, { recursive: true, force: true });
  fs.mkdirSync(WORK, { recursive: true });
  const prev = readJson(OUT, null);

  // Find the newest month available, trying the current month and up to five earlier ones.
  let url = OVERRIDE, period = '';
  const zipPath = path.join(WORK, 'enroll.zip');
  if (url) { if (!(await tryDownload(url, zipPath))) throw new Error(`Could not download ${url}`); period = (url.match(/(\d{4})-(\d{2})/) || []).slice(1).join('-'); }
  else {
    const now = new Date();
    for (let back = 0; back < 6 && !url; back++) {
      const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
      const y = d.getUTCFullYear(), m = d.getUTCMonth() + 1;
      const u = monthUrl(y, m);
      log(`Trying ${u}`);
      if (await tryDownload(u, zipPath)) { url = u; period = `${y}-${String(m).padStart(2, '0')}`; }
    }
    if (!url) throw new Error('No monthly enrollment file found for the last six months at the expected address');
  }
  log(`Using ${period}: ${url} (${(fs.statSync(zipPath).size / 1048576).toFixed(1)} MB)`);
  if (prev && prev.period === period && !OVERRIDE) { log('Already have this period. Nothing to do.'); fs.rmSync(WORK, { recursive: true, force: true }); return; }

  execSync(`unzip -o -q "${zipPath}" -d "${WORK}"`, { stdio: 'inherit' });
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
  const all = walk(WORK).filter((f) => f !== zipPath);
  log(`Files in zip: ${all.map((f) => path.relative(WORK, f)).join(', ')}`);
  const csvs = all.filter((f) => /\.csv$/i.test(f));
  const csv = csvs.find((f) => /plan/i.test(path.basename(f))) || csvs[0];
  if (!csv) throw new Error('No CSV in the enrollment zip');

  const lines = fs.readFileSync(csv, 'utf8').split(/\r?\n/).filter((l) => l.length);
  const header = parseCsvLine(lines[0]).map((h) => h.replace(/^\uFEFF/, '').trim());
  log(`Columns (${header.length}): ${header.join(' | ')}`);
  const idx = (names) => { for (const n of names) { const i = header.findIndex((h) => h.toLowerCase() === n.toLowerCase()); if (i >= 0) return i; } return -1; };
  const iC = idx(['Contract Number', 'Contract ID', 'CONTRACT_ID']);
  const iP = idx(['Plan ID', 'PLAN_ID']);
  const iE = idx(['Enrollment', 'ENROLLMENT']);
  const iParent = idx(['Parent Organization', 'PARENT_ORGANIZATION']);
  const iOrg = idx(['Organization Name', 'Organization Marketing Name']);
  const iType = idx(['Plan Type', 'PLAN_TYPE']);
  const iPartD = idx(['Offers Part D', 'OFFERS_PART_D']);
  if (iC < 0 || iP < 0 || iE < 0) throw new Error(`Could not find contract, plan or enrollment columns. Have: ${header.join(', ')}`);

  const plans = {}; let masked = 0; let total = 0; let rows = 0;
  for (const line of lines.slice(1)) {
    const f = parseCsvLine(line);
    const c = (f[iC] || '').trim(); const p = (f[iP] || '').trim().padStart(3, '0');
    if (!c) continue;
    rows++;
    const raw = (f[iE] || '').trim();
    const n = /^\d+$/.test(raw.replace(/,/g, '')) ? Number(raw.replace(/,/g, '')) : null;
    if (n == null) masked++;
    const key = `${c}|${p}`;
    plans[key] = { contract_id: c, plan_id: p, enrollment: n == null ? 0 : n, masked: n == null, cms_parent: iParent >= 0 ? (f[iParent] || '').trim() : '', org: iOrg >= 0 ? (f[iOrg] || '').trim() : '', plan_type: iType >= 0 ? (f[iType] || '').trim() : '', offers_partd: iPartD >= 0 ? (f[iPartD] || '').trim() : '' };
    total += plans[key].enrollment;
  }
  log(`Rows ${rows}, plans ${Object.keys(plans).length}, total enrollment ${total.toLocaleString()}, masked (under 11) ${masked}`);

  // Compare CMS parent organization with parents.js by contract name is not possible here (no contract name);
  // instead tally CMS parents and show the biggest, and show which CMS parents our map calls UNMAPPED via the plan file.
  const byCms = {};
  for (const p of Object.values(plans)) byCms[p.cms_parent || '(blank)'] = (byCms[p.cms_parent || '(blank)'] || 0) + p.enrollment;
  log('Enrollment by CMS parent organization (top 25):');
  Object.entries(byCms).sort((a, b) => b[1] - a[1]).slice(0, 25).forEach(([k, v]) => log(`   ${String(v.toLocaleString()).padStart(12)}  ${k}`));

  // Cross-check against our map using the latest snapshot's plans.csv
  const manifest = readJson(path.join(DATA_DIR, 'manifest.json'), null);
  if (manifest && manifest.latest) {
    const pf = path.join(DATA_DIR, 'snapshots', manifest.latest, 'plans.csv');
    if (fs.existsSync(pf)) {
      const pl = fs.readFileSync(pf, 'utf8').split('\n').filter(Boolean);
      const ph = parseCsvLine(pl[0]);
      const mismatch = {};
      for (const l of pl.slice(1)) {
        const f = parseCsvLine(l); const o = {}; ph.forEach((k, i) => { o[k] = f[i]; });
        const e = plans[`${o.contract_id}|${String(o.plan_id).padStart(3, '0')}`];
        if (!e || !e.cms_parent) continue;
        const k = `${o.parent}  <=  CMS says: ${e.cms_parent}`;
        if (!/^(UNMAPPED|Regional|Blue Cross|Institutional|Provider-sponsored)/.test(o.parent) && !e.cms_parent.toLowerCase().includes(o.parent.split(' ')[0].toLowerCase())) mismatch[k] = (mismatch[k] || 0) + e.enrollment;
        if (/^UNMAPPED/.test(o.parent)) mismatch[`UNMAPPED  <=  CMS says: ${e.cms_parent}`] = (mismatch[`UNMAPPED  <=  CMS says: ${e.cms_parent}`] || 0) + e.enrollment;
      }
      log('Possible parents.js disagreements with CMS parent organization (by enrollment, top 40):');
      Object.entries(mismatch).sort((a, b) => b[1] - a[1]).slice(0, 40).forEach(([k, v]) => log(`   ${String(v.toLocaleString()).padStart(12)}  ${k}`));
    }
  }

  fs.writeFileSync(OUT, JSON.stringify({ period, source_url: url, total_enrollment: total, masked_plans: masked, generated_at: new Date().toISOString(), plans }, null, 1));
  fs.rmSync(WORK, { recursive: true, force: true });
  log(`Wrote ${OUT}`);
}

main().catch((e) => { console.error('ENROLLMENT FAILED:', e.message); process.exit(1); });
