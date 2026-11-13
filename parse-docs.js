// parse-docs.js
// Turns the text captured by collect-docs.js into structured rows, compares
// versions, and builds a cross-book view of watchlist names.
//
// Parsers (chosen by source id prefix):
//   aetna-*   CVS Caremark / Aetna drug guide: one row per product with
//             category, name, generic, tier code (PB, PG, NP, NB, NF...), and
//             restrictions (PA, ST, QL with detail, SPC). Versions are compared
//             row by row: ADDED, REMOVED, TIER_CHANGED, RESTRICTION_CHANGED.
//   optum-*   Optum Rx Pharmacy Passages: each table row is already a change,
//             parsed as old tier, new tier, SP/PA/ST/QL flags and effective
//             date, plus the Add/Remove tables.
//   esi-*     Express Scripts exclusion lists: not parsed into rows yet; the
//             line-level diff from collect-docs.js still covers them.
//
// Outputs:
//   data/docs/<id>/parsed/<stamp>.json                rows for that version
//   data/docs/<id>/parsed/<prev>_to_<stamp>.diff.json  structured comparison (Aetna family)
//   data/docs/structured.json                          cross-book summary for the dashboard and email:
//                                                      per source: parser, row counts, parse problems,
//                                                      watchlist rows, latest structured changes
//
// No npm packages. Node 20 or newer. FORCE=true re-parses every version.

const fs = require('fs');
const path = require('path');
const { watchHits } = require('./watchlist');

const DATA_DIR = path.join(__dirname, 'data', 'docs');
const OUT = path.join(DATA_DIR, 'structured.json');
const FORCE = String(process.env.FORCE || '').toLowerCase() === 'true';
const ONLY = (process.env.ONLY || '').trim();

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function writeJson(f, o) { fs.writeFileSync(f, JSON.stringify(o, null, 2)); }
function norm(s) { return String(s || '').replace(/\s+/g, ' ').trim(); }
function key(s) { return norm(s).toUpperCase().replace(/[^A-Z0-9 ]/g, '').replace(/\s+/g, ' '); }

// ---------------------------------------------------------------------------
// Aetna / CVS Caremark drug guide parser (column-aware)
//
// pdftotext -layout keeps the three columns of the guide at fixed character
// offsets: product name | tier code | limits. The page header gives the
// offsets ("Drug Tier" and "Limits"), so each line is sliced into the three
// columns and only the name column has to handle wrapped text.
// ---------------------------------------------------------------------------

const TIER_TOKENS = ['PG', 'NP', 'PB', 'NB', 'NF', 'GN', 'BR'];
const TIER_RE = new RegExp(`\\b(${TIER_TOKENS.join('|')})\\b`);
const SKIP_RE = /\.{4,}|Pharmacy Drug Guide|^Prescription Drug Name|^Drug Tier|^Limits$|updated the first week|^\d{1,4}$|^Page \d+/i;
const FORM_WORDS = /\b(SOLUTION|TABLET|CAPSULE|INJECT|PEN|KIT|STRIP|SENSOR|DEVICE|POWDER|CREAM|SUSPENSION|SPRAY|INHAL|PATCH|GEL|OINTMENT|LOTION|DROPS?|SYRINGE|VIAL|CARTRIDGE|LANCET|RECEIVER|TRANSMITTER|PUMP|PODS?|KWIKPEN|SOLOSTAR|FLEXTOUCH|FLEXPEN|ORAL|SUBCUTANEOUS|INTRAVENOUS|NASAL|TOPICAL|OPHTHALMIC|OTIC|RECTAL|VAGINAL|TRANSDERMAL|INHALATION|CHEWABLE|GRANULE|ELIXIR|SYRUP|LOZENGE|FILM|IMPLANT|AEROSOL|EMULSION|FOAM|SHAMPOO|MG|ML|UNIT|MCG|AUTO-|PEN-)\b/i;

function parenBalance(s) { let o = 0, c = 0; for (const ch of s) { if (ch === '(') o++; else if (ch === ')') c++; } return o - c; }
function hasGeneric(s) { return /\(([a-z][^()]*(?:\([^()]*\)[^()]*)*)\)/.test(s); }

function isNameContinuation(t, soFar) {
  if (/^[\d.]+ ?(MG|ML|MCG|UNIT|UNT|%|X|GM|G)\b/i.test(t)) return true;
  if (/^(MG|ML|MCG|UNIT|UNT|GM|G)\b/i.test(t)) return true;
  if (!/\(/.test(t) && /\)\s*$/.test(t)) return true;                       // "sensor)" / "lispro)"
  if (/^[a-z]/.test(t) && /\)\s*$/.test(t) && !hasGeneric(soFar)) return true;
  if (/^(INJECTOR|KWIKPEN|SOLOSTAR|FLEXTOUCH|FLEXPEN|PEN-INJECTOR|CARTRIDGE|AUTO-INJECTOR|SUSPENSION|SOLUTION|TABLET|CAPSULE|POWDER|DEVICE|SENSOR|TRANSMITTER|RECEIVER|KIT|STRIP|LANCETS?|PODS?|MANAGEMENT|INHALER|SPRAY|DROPS)\b/i.test(t) && !hasGeneric(soFar)) return true;
  if (/^(management|weight)\b/i.test(t)) return true;
  if (/-$/.test(soFar.trim())) return true;                                 // previous line ended with a hyphen
  return false;
}

function finishAetnaEntry(e) {
  const nameText = norm(e.name.join(' '));
  const tierText = norm(e.tier.join(' '));
  const limitsText = norm(e.limits.join(' '));
  if (!nameText) return null;
  if (nameText.length > 400) return { problem: 'entry too long', text: nameText.slice(0, 160), category: e.category };
  const tierM = tierText.match(TIER_RE) || nameText.match(TIER_RE);
  if (!tierM) return { problem: 'no tier code', text: `${nameText} | ${tierText} | ${limitsText}`, category: e.category };
  const tier = tierM[1];
  const restr = [];
  const lim = limitsText || '';
  if (/\bPA\b/.test(lim)) restr.push('PA');
  if (/\bST\b/.test(lim)) restr.push('ST');
  if (/\bSPC\b/.test(lim)) restr.push('SPC');
  const ql = lim.match(/\bQL\s*\(([^)]*)\)?/i);
  if (ql) restr.push(`QL (${norm(ql[1])})`); else if (/\bQL\b/.test(lim)) restr.push('QL');
  if (/does not include certain NDCs/i.test(lim)) restr.push('certain NDCs excluded');
  if (/only preferred options|only certain NDCs/i.test(lim)) restr.push('preferred-NDC note');
  if (/\bN8\b/.test(lim)) restr.push('N8');
  let generic = '';
  const parens = [...nameText.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => m[1]);
  for (const p of parens) if (/^[a-z]/.test(p)) generic = norm(p);
  let name = nameText;
  if (generic) { const i = nameText.lastIndexOf('(' + generic); if (i > 0) name = nameText.slice(0, i); }
  name = norm(name.replace(TIER_RE, ''));
  return { category: e.category, name, generic, tier, restrictions: restr, limits: lim, text: `${nameText} | ${tierText} | ${lim}` };
}

// Split two-column pages into columns. pdftotext -layout keeps horizontal
// positions, so a vertical whitespace gap near the middle of a page marks the
// column boundary. Returns one entry per page: an array of columns, each an
// array of lines. Pages are separated by form feeds.
function pageColumns(text) {
  const pages = text.split('\f');
  const out = [];
  for (const page of pages) {
    const lines = page.split('\n').map((l) => l.replace(/\s+$/, ''));
    const width = Math.max(0, ...lines.map((l) => l.length));
    const nonEmpty = lines.filter((l) => l.trim().length);
    if (width < 90 || nonEmpty.length < 8) { out.push([lines]); continue; }
    let best = -1, bestScore = 0;
    for (let c = Math.floor(width * 0.35); c <= Math.floor(width * 0.65); c++) {
      let blank = 0;
      for (const l of nonEmpty) if (c >= l.length || (l[c] === ' ' && (l[c - 1] === ' ' || l[c + 1] === ' '))) blank++;
      const score = blank / nonEmpty.length;
      if (score > bestScore) { bestScore = score; best = c; }
    }
    if (bestScore < 0.97) { out.push([lines]); continue; }
    const left = lines.map((l) => l.slice(0, best).replace(/\s+$/, ''));
    const right = lines.map((l) => l.slice(best).replace(/^\s{0,2}/, '').replace(/\s+$/, ''));
    out.push([left, right]);
  }
  return out;
}

// Aetna booklet-style guide (seen in the 2026 Advanced Control Plan file): a
// product list where only exceptions carry a code (CE, NP, NPSP, PB, PG, PSP,
// NF). Listed products with no code are covered with tier unmarked.
const BOOKLET_CODES = ['NPSP', 'PSP', 'NP', 'PB', 'PG', 'NF', 'CE'];
const BOOKLET_RE = new RegExp(`(?:^|\\s)(${BOOKLET_CODES.join('|')})(?=\\s|$)`);
const BOOKLET_SKIP = /^\d{1,2}\/\d{1,2}\/\d{4}$|^Page \d|^\d{1,3}$|Advanced Control Plan|aetna\.com|Aetna Inc|Pharmacy Drug Guide/i;
const LEGEND_RE = /^(CE|NP|NPSP|PB|PG|PSP|NF)?\s*=\s*|lowercase italics\s*=|UPPERCASE\s*=|= Non-formulary|Copay Exception|exception request granted/i;

function parseAetnaBooklet(text) {
  const pages = pageColumns(text);
  const rows = []; const problems = []; const notes = { booklet: true, pages: pages.length };
  // Find the page holding the legend; parsing starts there, after the legend lines in each column.
  let legendPage = -1;
  for (let p = 0; p < pages.length; p++) if (pages[p].some((col) => col.some((l) => LEGEND_RE.test(l.trim()) && /Preferred|Non-formulary|Generic drugs|Brand name/i.test(l)))) { legendPage = p; break; }
  if (legendPage < 0) { legendPage = 0; notes.legendFound = false; }
  const lines = [];
  for (let p = legendPage; p < pages.length; p++) {
    for (const col of pages[p]) {
      let colLines = col;
      if (p === legendPage) { let last = -1; col.forEach((l, i) => { if (LEGEND_RE.test(l.trim())) last = i; }); colLines = col.slice(last + 1); }
      lines.push(...colLines);
    }
  }
  let category = ''; let buf = null;
  const isHeader = (t) => t && !/\(/.test(t) && t === t.toUpperCase() && /[A-Z]{3,}/.test(t) && !FORM_WORDS.test(t) && !/-$/.test(t) && t.length < 110 && !BOOKLET_RE.test(' ' + t) && !/\d+ MG|\d+ ML/.test(t);
  const cont = (t, soFar) => (soFar === soFar.toUpperCase() && !hasGeneric(soFar) && /^[A-Z0-9(]/.test(t) && /\([a-z][^()]*(\([^()]*\))?[^()]*\)\s*$/.test(t)) || (/^\([a-z]/.test(t) && !hasGeneric(soFar)) || /^[\d.]+ ?(MG|ML|MCG|UNIT|UNT|%|X|GM|G)\b/i.test(t) || /^(MG|ML|MCG|UNIT|GM|G)\b/i.test(t) || (!/\(/.test(t) && /\)\s*$/.test(t)) || /^(INJECTOR|KWIKPEN|SOLOSTAR|FLEXTOUCH|FLEXPEN|PEN-INJECTOR|CARTRIDGE|AUTO-INJECTOR|SYRINGE|THERAPY PACK|PACK|DETERRENT|RELEASE)\b/i.test(t) || (/-$/.test(soFar.trim())) || (/^[a-z]/.test(t) && /^[^A-Z]*\)\s*$/.test(t) && parenBalance(soFar) > 0) || (parenBalance(soFar) > 0 && !/\(/.test(t));
  const flush = () => {
    if (!buf) return;
    const t = norm(buf.join(' '));
    buf = null;
    if (!t || t.length > 400) { if (t) problems.push({ problem: 'entry too long', text: t.slice(0, 160), category }); return; }
    const codes = [...t.matchAll(new RegExp(BOOKLET_RE.source, 'g'))].map((m) => m[1]);
    const tier = codes.find((c) => c !== 'CE') || '';
    const restr = [];
    if (codes.includes('CE')) restr.push('CE copay exception');
    if (/\bPA\b/.test(t)) restr.push('PA');
    if (/\bST\b/.test(t)) restr.push('ST');
    if (/\bQL\b/.test(t)) restr.push('QL');
    if (/\bN7\b/.test(t)) restr.push('N7');
    let clean = t.replace(new RegExp(BOOKLET_RE.source, 'g'), ' ').replace(/\bN7 \(?/g, ' ').replace(/\bPA;?\b/g, ' ');
    clean = norm(clean);
    let generic = '';
    const parens = [...clean.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => m[1]);
    for (const p of parens) if (/^[a-z]/.test(p)) generic = norm(p);
    let name = clean;
    if (generic) { const i = clean.lastIndexOf('(' + generic); if (i > 0) name = clean.slice(0, i); }
    name = norm(name);
    if (!name || !/[A-Za-z]{3,}/.test(name)) return;
    // A product line carries a strength, a form word, a tier code or a generic; plain sentences do not.
    if (!generic && !tier && !/\d/.test(name) && !FORM_WORDS.test(name)) return;
    rows.push({ category, name, generic, tier, coverage: tier === 'NF' ? 'not covered' : 'listed', restrictions: restr, text: t });
  };
  for (const rawLine of lines) {
    const t = rawLine.trim();
    if (!t || BOOKLET_SKIP.test(t) || LEGEND_RE.test(t)) continue;
    if (/formulary is updated|Coverage Requirements|^Limits$|^Prescription Drug Name|^[A-Z0-9]{1,4} = |^Drug Tier|visit the website|member ID card|^Aetna\.com|^©/i.test(t)) continue;
    if (isHeader(t) && (!buf || parenBalance(buf.join(' ')) <= 0)) { flush(); category = t; continue; }
    if (buf && !cont(t, buf.join(' ')) && parenBalance(buf.join(' ')) <= 0) flush();
    if (!buf) buf = [];
    buf.push(t);
  }
  flush();
  return { rows, problems, notes };
}

function diffBooklet(prevRows, rows) { return diffAetna(prevRows, rows); }

function parseAetna(text) {
  const raw = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  // Column offsets from the page header
  let tierCol = -1, limitsCol = -1, headerCount = 0;
  for (let i = 0; i < raw.length; i++) {
    if (/Prescription Drug Name/.test(raw[i]) && /Drug Tier/.test(raw[i])) {
      headerCount++;
      if (tierCol < 0) {
        tierCol = raw[i].indexOf('Drug Tier');
        if (/Limits/.test(raw[i])) limitsCol = raw[i].indexOf('Limits');
        else for (let j = i + 1; j <= i + 2 && j < raw.length; j++) if (/Limits/.test(raw[j])) { limitsCol = raw[j].indexOf('Limits'); break; }
      }
    }
  }
  // A column-layout guide repeats the "Drug Tier" header on every page; a booklet mentions it once
  // in its front matter. Route on the count, not on the presence of a legend.
  const columnMode = tierCol > 10 && headerCount >= 5;
  if (!columnMode) return parseAetnaBooklet(text);
  if (columnMode && limitsCol <= tierCol) limitsCol = tierCol + 12;
  const rows = []; const problems = []; const notes = { columnMode, headerCount, tierCol, limitsCol, unknownTierTokens: {} };
  let category = ''; let e = null;
  const start = () => { e = { category, name: [], tier: [], limits: [] }; };
  const flush = () => { if (!e) return; const r = finishAetnaEntry(e); if (r && r.problem) problems.push(r); else if (r) rows.push(r); e = null; };
  const complete = () => e && e.tier.some((t) => TIER_RE.test(t)) && parenBalance(e.name.join(' ')) <= 0;

  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    const t = line.trim();
    if (!t || SKIP_RE.test(t)) continue;
    let nm, tr, lm;
    if (columnMode) {
      // Tolerate a name that runs a few characters into the tier column: look for the tier token in a window.
      const w0 = Math.max(0, tierCol - 4);
      const win = line.slice(w0, limitsCol + 4);
      const m = win.match(TIER_RE);
      if (m) { const pos = w0 + m.index; nm = line.slice(0, pos).trim(); tr = m[1]; lm = line.slice(pos + m[1].length).trim(); }
      else { nm = line.slice(0, tierCol).trim(); tr = ''; lm = line.slice(tierCol).trim(); }
    }
    else { const m = t.match(TIER_RE); if (m) { nm = t.slice(0, m.index).trim(); const rest = t.slice(m.index); tr = m[1]; lm = rest.slice(m[1].length).trim(); } else { nm = t; tr = ''; lm = ''; } }
    if (columnMode && !tr && lm && /^[A-Z]{2}\b/.test(lm) && !/^(PA|ST|QL|N8|SPC)\b/.test(lm)) { notes.unknownTierTokens[lm.slice(0, 2)] = (notes.unknownTierTokens[lm.slice(0, 2)] || 0) + 1; }
    // category header: name column only, all caps, no parentheses, no dosage-form words
    const isHeader = nm && !tr && !lm && !/\(/.test(nm) && nm === nm.toUpperCase() && /[A-Z]{3,}/.test(nm) && !FORM_WORDS.test(nm) && !/-$/.test(nm) && nm.length < 70;
    if (isHeader && (!e || complete())) { flush(); category = nm; continue; }
    if (e && complete() && nm && !isNameContinuation(nm, e.name.join(' '))) flush();
    if (!e) {
      if (!nm) { continue; }   // stray tier/limits text with no name (e.g. wrapped limits) belongs to the previous entry; ignored once flushed
      start();
    }
    if (nm) e.name.push(nm);
    if (tr) e.tier.push(tr);
    if (lm) e.limits.push(lm);
  }
  flush();
  return { rows, problems, notes };
}

function diffAetna(prevRows, rows) {
  const A = new Map(prevRows.map((r) => [key(r.name + ' ' + r.generic), r]));
  const B = new Map(rows.map((r) => [key(r.name + ' ' + r.generic), r]));
  const out = [];
  for (const [k, b] of B) {
    const a = A.get(k);
    if (!a) { out.push({ change: 'ADDED', name: b.name, generic: b.generic, category: b.category, tier_after: b.tier, restrictions_after: b.restrictions }); continue; }
    if (a.tier !== b.tier) out.push({ change: 'TIER_CHANGED', name: b.name, generic: b.generic, category: b.category, tier_before: a.tier, tier_after: b.tier, restrictions_after: b.restrictions });
    if (a.restrictions.join('|') !== b.restrictions.join('|')) out.push({ change: 'RESTRICTION_CHANGED', name: b.name, generic: b.generic, category: b.category, tier_after: b.tier, restrictions_before: a.restrictions, restrictions_after: b.restrictions });
  }
  for (const [k, a] of A) if (!B.has(k)) out.push({ change: 'REMOVED', name: a.name, generic: a.generic, category: a.category, tier_before: a.tier, restrictions_before: a.restrictions });
  return out;
}

// ---------------------------------------------------------------------------
// Optum Rx Pharmacy Passages parser (column-aware)
//
// Tables have a header with "Therapeutic use" and "Medication name"; the
// medication column offset is taken from that header and re-detected at
// every header, since each table in the issue can be laid out differently.
// A data row is a line ending in an effective date. Wrapped name fragments
// on the lines just above and below are read from the medication column.
// ---------------------------------------------------------------------------

const DATE_END = /(\d{1,2}\/\d{1,2}\/\d{2,4})\s*$/;
const TIER_FIELD = /(Tier\s*\d|EXC|\(N\/C\)|N\/C|\d\s*>\s*\d|Brand|Generic)/g;
const OPT_HEADER = /^(Therapeutic use|Medication name|Tier\b|Generic Tier|use Base|Brand\/Generic|Effective|Formulary|Prior Authorization|Step Therapy|Quantity Limit|Page|©|Optum|Pharmacy Passages|Add\/Remove)/i;

function parseOptum(text) {
  const raw = text.split('\n').map((l) => l.replace(/\s+$/, ''));
  const rows = []; const problems = []; const notes = { tables: 0 };
  const isData = (t) => DATE_END.test(t) && /(Tier\s*\d|EXC|Brand|Generic|\d\s*>\s*\d|\bAdd\b|\bRemove\b|N\/C)/.test(t);
  // Pass 1: locate tables (header offsets) and data lines
  const info = raw.map(() => null); // per line: {medCol, endCol, mode}
  let cur = { medCol: -1, endCol: -1, mode: 'tier' };
  for (let i = 0; i < raw.length; i++) {
    const line = raw[i];
    if (/Medication name/.test(line)) {
      cur = { medCol: line.indexOf('Medication name'), endCol: -1, mode: /Add\/Remove/.test(line) ? 'addremove' : 'tier' }; notes.tables++;
      for (let j = i; j <= i + 2 && j < raw.length; j++) {
        const m = raw[j].match(/Brand\/Generic|Generic\s{2,}Tier|\bTier\b|Add\/Remove/);
        if (m) { const c = raw[j].indexOf(m[0]); if (c > cur.medCol) { cur.endCol = c; break; } }
      }
    }
    info[i] = cur;
  }
  const dataIdx = raw.map((l, i) => isData(l.trim()) ? i : -1).filter((i) => i >= 0);
  const dataSet = new Set(dataIdx);
  // Pass 2: assign wrapped fragments (non-data, non-blank, non-header lines) to a data line
  const frags = new Map(); // data line -> [{i, text}]
  const medSlice = (i) => { const c = info[i]; const l = raw[i]; return (c.medCol >= 0 ? l.slice(c.medCol, c.endCol > c.medCol ? c.endCol : undefined) : l).trim(); };
  const useSlice = (i) => { const c = info[i]; return (c.medCol >= 0 ? raw[i].slice(0, c.medCol) : '').trim(); };
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i].trim();
    if (!t || dataSet.has(i) || OPT_HEADER.test(t) || /Medication name/.test(raw[i])) continue;
    const frag = medSlice(i);
    const useOnly = useSlice(i);
    if (!frag && !useOnly) continue;
    let up = -1, down = -1;
    for (let j = i - 1; j >= Math.max(0, i - 3); j--) { if (dataSet.has(j)) { up = j; break; } if (!raw[j].trim() || OPT_HEADER.test(raw[j].trim())) break; }
    for (let j = i + 1; j <= Math.min(raw.length - 1, i + 3); j++) { if (dataSet.has(j)) { down = j; break; } if (!raw[j].trim() || OPT_HEADER.test(raw[j].trim())) break; }
    let owner = -1;
    if (up >= 0 && down < 0) owner = up; else if (down >= 0 && up < 0) owner = down;
    else if (up >= 0 && down >= 0) owner = !frag ? up : (/^[a-z(]/.test(frag) ? up : down);
    if (owner < 0) continue;
    if (!frags.has(owner)) frags.set(owner, []);
    frags.get(owner).push({ i, text: frag, use: useOnly });
  }
  // Pass 3: build rows
  for (const i of dataIdx) {
    const line = raw[i]; const t = line.trim(); const c = info[i];
    const date = t.match(DATE_END)[1];
    const parts = (frags.get(i) || []).concat([{ i, text: medSlice(i), use: useSlice(i) }]).sort((a, b) => a.i - b.i);
    const therapeutic = norm(parts.map((p) => p.use).find(Boolean) || '');
    let body = norm(parts.map((p) => p.text).join(' ')).replace(DATE_END, '').trim();
    if (c.mode === 'addremove') {
      const m = t.match(/^(.*?)\s+(Add|Remove)\s+\d{1,2}\/\d{1,2}\/\d{2,4}\s*$/);
      const name = m ? norm((c.medCol >= 0 ? m[1].slice(c.medCol) : m[1])) : body.replace(/\b(Add|Remove)\b.*$/, '');
      rows.push({ kind: 'add_remove', action: m ? m[2] : '', therapeutic_use: therapeutic, name: norm(name), effective: date, text: t });
      continue;
    }
    const rest = c.endCol > c.medCol ? line.slice(c.endCol).replace(DATE_END, '').trim() : '';
    let tail = rest;
    if (!tail) { const m = body.search(TIER_FIELD); if (m < 0) { problems.push({ problem: 'no tier field', text: t }); continue; } tail = body.slice(m); body = body.slice(0, m); }
    body = norm(body.replace(TIER_FIELD, '').replace(/\b(X|---)\b/g, ''));
    const tiers = [...tail.matchAll(TIER_FIELD)].map((x) => norm(x[0]));
    const flags = tail.replace(TIER_FIELD, ' ').split(/\s+/).filter((x) => x === 'X' || x === '---');
    const flagMap = {};
    if (flags.length === 4) ['SP', 'PA', 'ST', 'QL'].forEach((n, j) => { flagMap[n] = flags[j] === 'X'; });
    else if (flags.length) flagMap.raw = flags.join(' ');
    let brandGeneric = '';
    const tierVals = tiers.filter((x) => { if (/^(Brand|Generic)$/i.test(x)) { brandGeneric = x; return false; } return true; });
    rows.push({ kind: 'tier_change', therapeutic_use: therapeutic, name: body, brand_generic: brandGeneric, tier_before: tierVals[0] || '', tier_after: tierVals[1] || tierVals[0] || '', flags: flagMap, effective: date, text: t });
  }
  return { rows, problems, notes };
}


// ---------------------------------------------------------------------------
// Optum Rx Pharmacy Passages parser from word coordinates (pdftotext -bbox-layout)
//
// Rebuilds each table row from word positions: a header line on the page
// gives the x position of every column (Therapeutic use, Medication name,
// Brand/Generic, Tier, Tier, SP, PA, ST, QL, Effective date, Add/Remove), and
// rows are grouped by the vertical gaps between lines. Wrapped names stay in
// one row because they sit between the same row borders.
// ---------------------------------------------------------------------------

function parseBboxWords(html) {
  const pages = [];
  const pageRe = /<page[^>]*width="([\d.]+)"[^>]*height="([\d.]+)"[^>]*>([\s\S]*?)<\/page>/g;
  let pm;
  while ((pm = pageRe.exec(html))) {
    const words = [];
    const wordRe = /<word xMin="([\d.]+)" yMin="([\d.]+)" xMax="([\d.]+)" yMax="([\d.]+)">([^<]*)<\/word>/g;
    let wm;
    while ((wm = wordRe.exec(pm[3]))) words.push({ x0: +wm[1], y0: +wm[2], x1: +wm[3], y1: +wm[4], t: wm[5].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'") });
    pages.push({ w: +pm[1], h: +pm[2], words });
  }
  return pages;
}

function groupLines(words, tol = 2.5) {
  const sorted = [...words].sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const w of sorted) {
    const L = lines[lines.length - 1];
    if (L && Math.abs(w.y0 - L.y0) <= tol) { L.words.push(w); L.y1 = Math.max(L.y1, w.y1); }
    else lines.push({ y0: w.y0, y1: w.y1, words: [w] });
  }
  for (const L of lines) {
    L.words.sort((a, b) => a.x0 - b.x0);
    // Glue fragments the PDF split mid-word (a gap of under a point and a half between them).
    const glued = [];
    for (const w of L.words) {
      const p = glued[glued.length - 1];
      if (p && w.x0 - p.x1 < 1.5 && w.x0 - p.x1 > -2) { p.t += w.t; p.x1 = Math.max(p.x1, w.x1); }
      else glued.push({ ...w });
    }
    L.words = glued;
  }
  return lines;
}

function findHeader(line) {
  // Returns column x positions when this line is a table header, else null.
  const t = line.words.map((w) => w.t);
  const joined = t.join(' ');
  if (!/Medication/i.test(joined)) return null;
  const col = {};
  const at = (re) => { const w = line.words.find((x) => re.test(x.t)); return w ? w.x0 : null; };
  const endOf = (re) => { const ws = line.words.filter((x) => re.test(x.t)); return ws.length ? Math.max(...ws.map((x) => x.x1)) : null; };
  col.use = at(/^Therapeutic$/i);
  col.useEnd = endOf(/^(Therapeutic|use)$/i);
  col.med = at(/^Medication$/i);
  col.medEnd = endOf(/^(Medication|name)$/i);
  col.bg = at(/^Brand\/(Generic)?$/i);
  const tiers = line.words.filter((x) => /^Tier$/i.test(x.t)).map((x) => x.x0);
  col.tier1 = tiers[0] != null ? tiers[0] : null; col.tier2 = tiers[1] != null ? tiers[1] : null;
  col.base = at(/^Base$/i); col.enh = at(/^Enhanced$/i);
  col.sp = at(/^SP$/); col.pa = at(/^PA$/); col.st = at(/^ST$/); col.ql = at(/^QL$/);
  col.addrem = at(/^Add\/Remove$/i);
  col.date = at(/^(Effective|date)$/i);
  if (col.med == null) return null;
  return col;
}

// Optum tier cells read "Tier 2", "3 > 2", "EXC", "(N/C) > EXC", "---". Two tier columns are the Select
// and Premium formularies (or Base and Enhanced for EHB issues), not before and after.
const TIER_TOKEN = /^(Tier\s?\d|\d|EXC\^?|\(N\/C\)|N\/C|---|N\/A|NC)$/i;
function parseTierTokens(tokens) {
  const segs = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (!TIER_TOKEN.test(t)) continue;
    if (tokens[i + 1] === '>' && tokens[i + 2] && TIER_TOKEN.test(tokens[i + 2])) { segs.push({ from: t, to: tokens[i + 2] }); i += 2; }
    else segs.push({ status: t });
  }
  return segs;
}
const segText = (g) => (!g ? '' : g.from != null ? `${g.from} > ${g.to}` : g.status);

function parseOptumBbox(html) {
  const pages = parseBboxWords(html);
  const rows = []; const problems = []; const notes = { bbox: true, pages: pages.length, tables: 0 };
  const DATE = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;
  const HEADER_WORD = /^(use|name|Base|Enhanced|date|SP|PA|ST|QL|Tier|Brand\/|Brand\/Generic|Generic|Add\/Remove|Effective|Therapeutic|Medication|Brand|Current|New|Change|Changes|Coverage|Status|Utilization|Management|UM|Select|Premium|Formulary|EHB)$/i;
  for (const page of pages) {
    const lines = groupLines(page.words);
    // 1. Find table headers. A page may carry two tables side by side, so a header line can hold
    //    two "Medication" words; each one defines a table region by x.
    const tables = [];
    for (let li = 0; li < lines.length; li++) {
      const L = lines[li];
      if (!L.words.some((w) => /^Medication$/i.test(w.t))) continue;
      const merged = { y0: L.y0, y1: L.y1, words: [...L.words] };
      let k = li + 1;
      while (k < lines.length && lines[k].y0 - merged.y1 < 18 && lines[k].words.length && lines[k].words.every((w) => HEADER_WORD.test(w.t))) { merged.words.push(...lines[k].words); merged.y1 = Math.max(merged.y1, lines[k].y1); k++; }
      merged.words.sort((a, b) => a.x0 - b.x0);
      const meds = merged.words.filter((w) => /^Medication$/i.test(w.t));
      const starts = meds.map((m) => { const th = merged.words.filter((w) => /^Therapeutic$/i.test(w.t) && w.x0 < m.x0).pop(); return th ? th.x0 - 4 : m.x0 - 70; });
      for (let i = 0; i < meds.length; i++) {
        const x0 = starts[i], x1 = i + 1 < starts.length ? starts[i + 1] - 1 : 9999;
        const col = findHeader({ words: merged.words.filter((w) => w.x0 >= x0 && w.x0 < x1) });
        if (col) tables.push({ col, x0, x1, yTop: merged.y1, yBottom: 9999 });
      }
      li = k - 1;
    }
    if (!tables.length) continue;
    notes.tables += tables.length;
    for (const t of tables) for (const u of tables) if (u !== t && u.yTop > t.yTop && u.x0 < t.x1 && u.x1 > t.x0) t.yBottom = Math.min(t.yBottom, u.yTop - 2);
    // 2. For each table, group its lines into entries and read the cells.
    for (const tb of tables) {
      const c = tb.col;
      const tl = lines.map((L) => ({ y0: L.y0, y1: L.y1, words: L.words.filter((w) => w.x0 >= tb.x0 && w.x0 < tb.x1) })).filter((L) => L.words.length && L.y0 > tb.yTop + 1 && L.y1 < tb.yBottom);
      const entries = []; let cur = null; let lastY1 = null;
      const flushEntry = () => { if (cur && cur.lines.length) entries.push(cur); cur = null; };
      for (const L of tl) {
        const text = L.words.map((w) => w.t).join(' ');
        if (/^(Pharmacy Passages|©|Optum|Page \d|\d+$)/i.test(text)) continue;
        const gap = lastY1 == null ? 0 : L.y0 - lastY1;
        const lineH = L.y1 - L.y0 || 10;
        const hasDate = L.words.some((w) => DATE.test(w.t));
        if (!cur || gap > lineH * 0.6 || (hasDate && cur.hasDate)) { flushEntry(); cur = { lines: [], hasDate: false }; }
        cur.lines.push(L); if (hasDate) cur.hasDate = true;
        lastY1 = L.y1;
      }
      flushEntry();
      for (const e of entries) {
        const words = e.lines.flatMap((L) => L.words);
        const nextStart = [c.bg, c.tier1, c.base, c.addrem, c.date].filter((x) => x != null).sort((a, b) => a - b)[0];
        const xend = nextStart == null ? 9999 : nextStart - 6;
        const useParts = [], nameParts = [];
        for (const L of e.lines) {
          const left = L.words.filter((w) => w.x0 < xend);
          if (!left.length) continue;
          let cut = -1, best = 7;
          for (let i = 1; i < left.length; i++) { const g = left[i].x0 - left[i - 1].x1; if (g > best && left[i - 1].x1 < c.med + 4) { best = g; cut = i; } }
          if (cut > 0) { useParts.push(left.slice(0, cut).map((w) => w.t).join(' ')); nameParts.push(left.slice(cut).map((w) => w.t).join(' ')); }
          else if (left[0].x0 < c.med - 30 && c.use != null && left[left.length - 1].x1 < c.med - 4) useParts.push(left.map((w) => w.t).join(' '));
          else nameParts.push(left.map((w) => w.t).join(' '));
        }
        let use = norm(useParts.join(' '));
        let name = norm(nameParts.join(' '));
        const right = words.filter((w) => w.x0 >= xend).sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
        const date = (right.find((w) => DATE.test(w.t)) || {}).t || '';
        if (!name && !date) continue;
        if (c.addrem != null) {
          const ar = (right.find((w) => /^(Add|Remove)$/i.test(w.t)) || {}).t || '';
          if (!date) { problems.push({ problem: 'add/remove row without date', text: `${use} | ${name}` }); continue; }
          rows.push({ kind: 'add_remove', action: ar, therapeutic_use: use, name, effective: date, text: `${use} | ${name} | ${ar} ${date}` });
          continue;
        }
        if (!date) { if (name.length > 3) problems.push({ problem: 'row without date', text: `${use} | ${name}` }); continue; }
        // Cells right of the name: brand/generic, tier statuses, flags.
        const tokens = right.filter((w) => !DATE.test(w.t)).map((w) => w.t);
        let brandGeneric = tokens.find((t) => /^(Brand|Generic)$/i.test(t)) || '';
        if (!brandGeneric) { const m = name.match(/\b(Brand|Generic)\b/); if (m) { brandGeneric = m[1]; name = norm(name.replace(/\b(Brand|Generic)\b/, ' ')); } }
        // Flag columns by anchor (an X under SP, PA, ST or QL)
        const flags = {};
        for (const k of ['sp', 'pa', 'st', 'ql']) if (c[k] != null) flags[k.toUpperCase()] = right.some((w) => /^X$/i.test(w.t) && Math.abs(w.x0 - c[k]) < 14);
        // Tier tokens in reading order, "Tier" joined to its number
        const tt = [];
        for (let i = 0; i < tokens.length; i++) { if (/^Tier$/i.test(tokens[i]) && /^\d$/.test(tokens[i + 1] || '')) { tt.push(`Tier ${tokens[i + 1]}`); i++; } else tt.push(tokens[i]); }
        const segs = parseTierTokens(tt.filter((t) => !/^(Brand|Generic|X)$/i.test(t)));
        const twoCols = (c.tier1 != null && c.tier2 != null) || (c.base != null && c.enh != null);
        const select = segs[0] || null; const premium = twoCols ? (segs[1] || segs[0] || null) : null;
        const colNames = c.base != null ? ['Base', 'Enhanced'] : ['Select', 'Premium'];
        const statusOf = (g) => (!g ? '' : g.to != null ? g.to : g.status);
        const excluded = [select, premium].some((g) => g && /EXC|N\/C|NC/i.test(statusOf(g)));
        const moved = [select, premium].some((g) => g && g.from != null && g.from !== g.to);
        const summary = [select ? `${colNames[0]} ${segText(select)}` : '', premium ? `${colNames[1]} ${segText(premium)}` : ''].filter(Boolean).join('; ');
        rows.push({
          kind: 'tier_change', therapeutic_use: use, name, brand_generic: brandGeneric,
          select: select ? segText(select) : '', premium: premium ? segText(premium) : '', formulary_columns: colNames,
          status_select: statusOf(select), status_premium: statusOf(premium), moved, excluded,
          tier_before: select ? (select.from != null ? select.from : select.status) : '', tier_after: statusOf(select),
          flags, effective: date, text: `${use} | ${name} | ${summary} | ${date}`,
        });
      }
    }
  }
  return { rows, problems, notes };
}


// ---------------------------------------------------------------------------
// Aetna drug guide parser from word coordinates (pdftotext -bbox)
//
// Each page carries one or two column blocks headed "Prescription Drug Name",
// "Drug Tier" and "Coverage Requirements and Limits". Within a block, product
// entries are read from the name column (wrapped lines joined), the tier code
// from the tier column and the restriction codes from the limits column.
// ---------------------------------------------------------------------------

function parseAetnaBbox(html) {
  const pages = parseBboxWords(html);
  const rows = []; const problems = []; const notes = { bbox: true, pages: pages.length, blocks: 0, unknownTier: {} };
  const TIER_CODE = /^(PB|PG|NP|NPSP|PSP|NF|N8|NB|CE)$/;
  let category = '';
  for (const page of pages) {
    const lines = groupLines(page.words, 2.2);
    // Header blocks on this page
    const blocks = [];
    for (const L of lines) {
      const t = L.words.map((w) => w.t);
      const iP = t.findIndex((x) => /^Prescription$/.test(x));
      const iT = t.findIndex((x, i) => /^Tier$/.test(x) && i > iP);
      if (iP < 0 || iT < 0) continue;
      const iD = t.findIndex((x, i) => /^Drug$/.test(x) && i > iP && i < iT + 1 && i === iT - 1);
      const nameX = L.words[iP].x0;
      const tierX = L.words[iD >= 0 ? iD : iT].x0;
      const iC = t.findIndex((x, i) => /^(Coverage|Limits)$/.test(x) && i > iT);
      const limX = iC >= 0 ? L.words[iC].x0 : tierX + 40;
      blocks.push({ nameX, tierX, limX, y: L.y1 });
    }
    if (!blocks.length) continue;
    blocks.sort((a, b) => a.nameX - b.nameX);
    notes.blocks += blocks.length;
    for (let b = 0; b < blocks.length; b++) {
      const blk = blocks[b];
      const xStart = blk.nameX - 8;
      const xStop = b + 1 < blocks.length ? blocks[b + 1].nameX - 8 : 9999;
      const tierLeft = blk.tierX - 6, limLeft = blk.limX - 6;
      // Lines belonging to this block (below its header, inside its x range)
      const blines = lines.filter((L) => L.y0 > blk.y + 1 && L.words.some((w) => w.x0 >= xStart && w.x0 < xStop))
        .map((L) => ({ y0: L.y0, words: L.words.filter((w) => w.x0 >= xStart && w.x0 < xStop) }));
      let buf = null;
      const flush = () => {
        if (!buf) return;
        const nameText = norm(buf.name.join(' '));
        const tier = buf.tier.find((x) => x !== 'CE') || '';
        const restr = [];
        if (buf.tier.includes('CE')) restr.push('CE copay exception');
        const lim = norm(buf.lim.join(' '));
        for (const k of ['PA', 'ST', 'QL', 'N8', 'SPC', 'AL']) if (new RegExp(`\\b${k}\\b`).test(lim)) restr.push(k);
        const parens = [...nameText.matchAll(/\(([^()]*(?:\([^()]*\)[^()]*)*)\)/g)].map((m) => m[1]);
        let generic = ''; for (const p of parens) if (/^[a-z]/.test(p)) generic = norm(p);
        let name = nameText; if (generic) { const i = nameText.lastIndexOf('(' + generic); if (i > 0) name = nameText.slice(0, i); }
        name = norm(name);
        buf = null;
        if (!name || name.length > 300) { if (name) problems.push({ problem: 'entry too long', text: name.slice(0, 120) }); return; }
        if (!generic && !tier && !/\d/.test(name) && !FORM_WORDS.test(name)) return;
        if (/^\d{1,2}\/\d{1,2}\/\d{4}$/.test(name) || /Pharmacy Drug Guide|Advanced Control Plan|^Aetna\b/i.test(name)) return;
        const limClean = norm(lim.replace(/\(?Listing does not include certain NDCs\)?/gi, ' ').replace(/^certain NDCs\)/i, ' ').replace(/N8 \(?$/, 'N8'));
        rows.push({ category, name, generic, tier, coverage: tier === 'NF' ? 'not covered' : 'listed', restrictions: restr, limits_text: limClean, text: `${nameText} | ${tier} | ${limClean}` });
      };
      for (const L of blines) {
        const nameWords = L.words.filter((w) => w.x0 < tierLeft);
        const tierWords = L.words.filter((w) => w.x0 >= tierLeft && w.x0 < limLeft);
        const limWords = L.words.filter((w) => w.x0 >= limLeft);
        const nameT = nameWords.map((w) => w.t).join(' ').trim();
        if (!nameT && !tierWords.length && !limWords.length) continue;
        if (/^(The formulary is updated|Coverage Requirements|Limits$|Aetna\.com|©|[A-Z0-9]{1,4} = )/i.test(nameT) || /^\d+$/.test(nameT)) continue;
        // Category header: all caps, no strength, no tier, starts at the column edge
        const isCat = nameT && nameT === nameT.toUpperCase() && /[A-Z]{3,}/.test(nameT) && !/\d+ ?(MG|ML|MCG|UNIT|%)/.test(nameT) && !FORM_WORDS.test(nameT) && !tierWords.length && !/\(/.test(nameT) && nameWords[0].x0 < blk.nameX + 3;
        if (isCat) { flush(); category = nameT; continue; }
        // Continuation when the open entry has unbalanced parentheses, lacks its generic and this line supplies it,
        // or this line starts with a form word or a strength; or when the line is indented past the column edge.
        const soFar = buf ? buf.name.join(' ') : '';
        const indented = nameWords.length && nameWords[0].x0 >= blk.nameX + 3;
        const CONT_START = /^(SOLUTION|SUSPENSION|INJECT|INJECTOR|PEN-INJECTOR|CARTRIDGE|AUTO-INJECTOR|SYRINGE|THERAPY PACK|PACK|DETERRENT|RELEASE|KWIKPEN|SOLOSTAR|FLEXTOUCH|FLEXPEN|RECONSTITUTED|EXTENDED|DELAYED|[\d.]+ ?(MG|ML|MCG|UNIT|UNT|%|X|GM)\b|(MG|ML|MCG|UNIT|GM)\b|\([a-z])/i;
        const isCont = buf && nameT && (indented || parenBalance(soFar) > 0 || (soFar === soFar.toUpperCase() && !hasGeneric(soFar) && /\([a-z]/.test(nameT)) || (!/\d/.test(soFar) && CONT_START.test(nameT)) || (/^[a-z]/.test(nameT) && /^[a-z]/.test(soFar) && !/\d/.test(soFar)));
        const startsEntry = nameWords.length && !isCont;
        if (startsEntry && buf) flush();
        if (!buf) buf = { name: [], tier: [], lim: [] };
        if (nameT) buf.name.push(nameT);
        for (const w of tierWords) { if (TIER_CODE.test(w.t)) buf.tier.push(w.t); else { notes.unknownTier[w.t] = (notes.unknownTier[w.t] || 0) + 1; buf.lim.push(w.t); } }
        if (limWords.length) buf.lim.push(limWords.map((w) => w.t).join(' '));
      }
      flush();
    }
  }
  return { rows, problems, notes };
}

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

function parserFor(id) {
  if (id.startsWith('aetna-')) return { name: 'aetna-guide', parse: parseAetna, diff: diffAetna };
  if (id.startsWith('optum-pharmacy-passages') || id.startsWith('optum-pp')) return { name: 'optum-passages', parse: parseOptum, diff: null };
  return null;
}

function tagWatch(row) {
  const h = watchHits(`${row.name || ''} ${row.generic || ''}`);
  if (h.length) { row.watch_tickers = [...new Set(h.map((x) => x.ticker).filter(Boolean))]; row.watch_labels = [...new Set(h.map((x) => x.label))]; }
  return row;
}

function main() {
  const index = readJson(path.join(DATA_DIR, 'index.json'), { sources: {} });
  const structured = readJson(OUT, { sources: {} });
  const ids = fs.readdirSync(DATA_DIR).filter((d) => fs.statSync(path.join(DATA_DIR, d)).isDirectory());

  for (const id of ids) {
    if (ONLY && id !== ONLY) continue;
    const p = parserFor(id);
    const meta = readJson(path.join(DATA_DIR, id, 'meta.json'), null);
    if (!meta || !meta.versions || !meta.versions.length) continue;
    const src = index.sources[id] || {};
    const entry = structured.sources[id] || { id, pbm: src.pbm || '', name: src.name || id, parser: p ? p.name : 'none', versions: {} };
    entry.parser = p ? p.name : 'none';
    entry.pbm = src.pbm || entry.pbm; entry.name = src.name || entry.name; entry.url = src.url || entry.url;
    if (!p) { structured.sources[id] = entry; continue; }

    const pdir = path.join(DATA_DIR, id, 'parsed');
    fs.mkdirSync(pdir, { recursive: true });
    let prevRows = null; let prevStamp = null;
    for (const v of meta.versions) {
      const txt = path.join(DATA_DIR, id, `${v.stamp}.txt`);
      if (!fs.existsSync(txt)) continue;
      const outFile = path.join(pdir, `${v.stamp}.json`);
      const bbox = path.join(DATA_DIR, id, `${v.stamp}.bbox.html`);
      let parsed;
      if (fs.existsSync(outFile) && !FORCE) parsed = readJson(outFile, null);
      if (!parsed) {
        const useBbox = (p.name === 'optum-passages' || p.name === 'aetna-guide') && fs.existsSync(bbox);
        log(`Parsing ${id} ${v.stamp} with ${p.name}${useBbox ? ' (word coordinates)' : ''}`);
        parsed = useBbox ? (p.name === 'aetna-guide' ? parseAetnaBbox(fs.readFileSync(bbox, 'utf8')) : parseOptumBbox(fs.readFileSync(bbox, 'utf8'))) : p.parse(fs.readFileSync(txt, 'utf8'));
        parsed.rows.forEach(tagWatch);
        writeJson(outFile, parsed);
        log(`   rows: ${parsed.rows.length}, problems: ${parsed.problems.length}, watchlist rows: ${parsed.rows.filter((r) => r.watch_tickers).length}; notes ${JSON.stringify(parsed.notes || {})}`);
        const watchRows = parsed.rows.filter((r) => r.watch_tickers && r.watch_tickers.length);
        if (watchRows.length) {
          log('   watchlist rows (up to 40):');
          watchRows.slice(0, 40).forEach((r) => log(`      [${r.watch_tickers.join(' ')}] ${r.kind === 'tier_change' ? `${r.name} | ${r.tier_before} -> ${r.tier_after} | ${JSON.stringify(r.flags)} | eff ${r.effective}` : r.kind === 'add_remove' ? `${r.action} ${r.name} eff ${r.effective}` : `${r.category} | ${r.name} (${r.generic}) | ${r.tier} | ${r.restrictions.join(', ')}`}`));
        }
        if (parsed.problems.length) { log('   first 10 parse problems:'); parsed.problems.slice(0, 10).forEach((x) => log(`      ${x.problem}: ${x.text.slice(0, 140)}`)); }
        log('   sample of 8 parsed rows:');
        parsed.rows.slice(0, 8).forEach((r) => log(`      ${JSON.stringify({ ...r, text: undefined })}`));
      }
      entry.versions[v.stamp] = { rows: parsed.rows.length, problems: parsed.problems.length, watch_rows: parsed.rows.filter((r) => r.watch_tickers).length };
      if (p.diff && prevRows) {
        const dfile = path.join(pdir, `${prevStamp}_to_${v.stamp}.diff.json`);
        if (!fs.existsSync(dfile) || FORCE) {
          const d = p.diff(prevRows, parsed.rows).map(tagWatch);
          writeJson(dfile, { id, prev: prevStamp, latest: v.stamp, changes: d });
          log(`   diff ${prevStamp} -> ${v.stamp}: ${d.length} structured changes (${d.filter((x) => x.watch_tickers).length} on watchlist)`);
          d.filter((x) => x.watch_tickers).slice(0, 20).forEach((x) => log(`      ${x.change} ${x.name} ${x.tier_before || ''} -> ${x.tier_after || ''}`));
        }
        entry.latest_diff = path.basename(dfile);
      }
      prevRows = parsed.rows; prevStamp = v.stamp;
    }
    // Latest watchlist rows and (for Optum) latest changes, for the cross-book view
    entry.latest_stamp = prevStamp;
    entry.watch_rows = (prevRows || []).filter((r) => r.watch_tickers).map((r) => ({ ...r, text: undefined }));
    if (p.name === 'optum-passages') entry.changes = (prevRows || []).map((r) => ({ ...r, text: undefined }));
    if (entry.latest_diff) entry.latest_changes = readJson(path.join(pdir, entry.latest_diff), { changes: [] }).changes;
    structured.sources[id] = entry;
  }

  // Edition comparisons: sources whose ids differ only by a year (aetna-acp-2026 vs aetna-acp-2027)
  // are compared product by product, so a coverage swap between plan years is produced here.
  structured.comparisons = [];
  const families = {};
  for (const e of Object.values(structured.sources)) { const m = e.id.match(/^(.*)-(20\d\d)$/); if (m && e.parser === 'aetna-guide') (families[m[1]] = families[m[1]] || []).push({ year: m[2], e }); }
  for (const [fam, list] of Object.entries(families)) {
    list.sort((a, b) => a.year.localeCompare(b.year));
    for (let i = 0; i + 1 < list.length; i++) {
      const A = list[i], B = list[i + 1];
      const ra = readJson(path.join(DATA_DIR, A.e.id, 'parsed', `${A.e.latest_stamp}.json`), { rows: [] }).rows;
      const rb = readJson(path.join(DATA_DIR, B.e.id, 'parsed', `${B.e.latest_stamp}.json`), { rows: [] }).rows;
      const key = (r) => `${norm(r.name).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()}|${(r.generic || '').toLowerCase()}`;
      const ma = new Map(ra.map((r) => [key(r), r])), mb = new Map(rb.map((r) => [key(r), r]));
      const changes = [];
      const restrOf = (r) => (r.restrictions || []).map((x) => x.replace(/\s*\(.*$/, '')).sort().join(', ');
      for (const [k, b] of mb) {
        const a = ma.get(k);
        const base = { category: b.category, name: b.name, generic: b.generic, from_tier: a ? a.tier : '', to_tier: b.tier, from_restrictions: a ? restrOf(a) : '', to_restrictions: restrOf(b) };
        if (!a) { changes.push({ change: 'ADDED', ...base }); continue; }
        if (a.tier === 'NF' && b.tier && b.tier !== 'NF') changes.push({ change: 'NOW_COVERED', ...base });
        else if (b.tier === 'NF' && a.tier && a.tier !== 'NF') changes.push({ change: 'NOW_NOT_COVERED', ...base });
        else if ((a.tier || '') !== (b.tier || '')) changes.push({ change: 'TIER_CHANGED', ...base });
        else if (restrOf(a) !== restrOf(b)) changes.push({ change: 'RESTRICTION_CHANGED', ...base });
      }
      for (const [k, a] of ma) if (!mb.has(k)) changes.push({ change: 'REMOVED', category: a.category, name: a.name, generic: a.generic, from_tier: a.tier, to_tier: '', from_restrictions: restrOf(a), to_restrictions: '' });
      for (const ch of changes) tagWatch(ch);
      const order = { NOW_NOT_COVERED: 0, REMOVED: 1, TIER_CHANGED: 2, RESTRICTION_CHANGED: 3, NOW_COVERED: 4, ADDED: 5 };
      changes.sort((x, y) => (order[x.change] - order[y.change]) || ((y.watch_tickers ? 1 : 0) - (x.watch_tickers ? 1 : 0)) || x.name.localeCompare(y.name));
      const comp = { family: fam, from_id: A.e.id, to_id: B.e.id, from_name: A.e.name, to_name: B.e.name, from_year: A.year, to_year: B.year, rows_from: ra.length, rows_to: rb.length, counts: {}, changes };
      for (const ch of changes) comp.counts[ch.change] = (comp.counts[ch.change] || 0) + 1;
      structured.comparisons.push(comp);
      log(`Edition comparison ${A.e.id} -> ${B.e.id}: ${JSON.stringify(comp.counts)}; watchlist changes: ${changes.filter((c) => c.watch_tickers).length}`);
      changes.filter((c) => c.watch_tickers).slice(0, 40).forEach((c) => log(`   ${c.change.padEnd(18)} [${c.watch_tickers.join(' ')}] ${c.name}${c.generic ? ` (${c.generic})` : ''}: ${c.from_tier || '-'} ${c.from_restrictions ? `[${c.from_restrictions}] ` : ''}-> ${c.to_tier || '-'} ${c.to_restrictions ? `[${c.to_restrictions}]` : ''}`));
    }
  }

  structured.generated_at = new Date().toISOString();
  writeJson(OUT, structured);
  log(`Wrote ${OUT}`);

  // Short human-readable report, small enough to read from a link.
  const lines = [`# Formulary monitor: commercial documents report`, ``, `Generated ${structured.generated_at}`, ``];
  for (const e of Object.values(structured.sources)) {
    const v = e.latest_stamp ? e.versions[e.latest_stamp] : null;
    lines.push(`## ${e.name} (${e.id})`, `Parser: ${e.parser}${v ? `; rows ${v.rows}, problems ${v.problems}, watchlist rows ${v.watch_rows}` : ''}${e.latest_diff ? `; latest diff ${e.latest_diff} with ${(e.latest_changes || []).length} changes` : ''}`, ``);
    if (e.parser === 'none') { lines.push(''); continue; }
    const pf = path.join(DATA_DIR, e.id, 'parsed', `${e.latest_stamp}.json`);
    const parsed = readJson(pf, null);
    if (parsed && parsed.notes) lines.push(`Notes: ${JSON.stringify(parsed.notes)}`, ``);
    if (parsed && parsed.problems && parsed.problems.length) { lines.push(`Problems (first 12):`); parsed.problems.slice(0, 12).forEach((p) => lines.push(`- ${p.problem}: ${String(p.text).slice(0, 140)}`)); lines.push(''); }
    if (parsed && parsed.rows) { lines.push(`Sample rows (first 10):`); parsed.rows.slice(0, 10).forEach((r) => lines.push(`- ${rowLine(r)}`)); lines.push(''); }
    if (e.watch_rows && e.watch_rows.length) { lines.push(`Watchlist rows (up to 60 of ${e.watch_rows.length}):`); e.watch_rows.slice(0, 60).forEach((r) => lines.push(`- [${(r.watch_tickers || []).join(' ')}] ${rowLine(r)}`)); lines.push(''); }
    if (e.latest_changes && e.latest_changes.length) { lines.push(`Structured changes vs previous version (watchlist first, up to 60):`); const w = e.latest_changes.filter((c) => c.watch_tickers); const o = e.latest_changes.filter((c) => !c.watch_tickers); w.concat(o).slice(0, 60).forEach((c) => lines.push(`- ${c.change} ${c.name}${c.generic ? ` (${c.generic})` : ''}: ${c.tier_before || '-'} -> ${c.tier_after || '-'}${c.restrictions_after ? ` [${c.restrictions_after.join(', ')}]` : ''}`)); lines.push(''); }
  }
  for (const comp of structured.comparisons || []) {
    lines.push(`## Edition comparison: ${comp.from_name} -> ${comp.to_name}`, `Rows ${comp.rows_from} -> ${comp.rows_to}; changes ${JSON.stringify(comp.counts)}`, ``);
    const w = comp.changes.filter((c) => c.watch_tickers);
    if (w.length) { lines.push(`Watchlist changes (${w.length}):`); w.slice(0, 80).forEach((c) => lines.push(`- ${c.change} [${c.watch_tickers.join(' ')}] ${c.name}${c.generic ? ` (${c.generic})` : ''}: ${c.from_tier || '-'}${c.from_restrictions ? ` [${c.from_restrictions}]` : ''} -> ${c.to_tier || '-'}${c.to_restrictions ? ` [${c.to_restrictions}]` : ''}`)); lines.push(''); }
    const o = comp.changes.filter((c) => !c.watch_tickers && /NOW_NOT_COVERED|NOW_COVERED/.test(c.change));
    if (o.length) { lines.push(`Other coverage changes (first 40 of ${o.length}):`); o.slice(0, 40).forEach((c) => lines.push(`- ${c.change} ${c.name}${c.generic ? ` (${c.generic})` : ''}: ${c.from_tier || '-'} -> ${c.to_tier || '-'}`)); lines.push(''); }
  }
  fs.writeFileSync(path.join(DATA_DIR, 'report.md'), lines.join('\n'));
  log('Wrote data/docs/report.md');
}

function rowLine(r) {
  const cut = (v, n = 160) => { const t = String(v == null ? '' : v); return t.length > n ? t.slice(0, n) + '…' : t; };
  if (r.name && String(r.name).length > 200) return `(oversized row, ${String(r.name).length} chars) ${cut(r.name)}`;
  if (r.kind === 'tier_change') return `${r.therapeutic_use ? r.therapeutic_use + ' | ' : ''}${r.name} | ${r.select != null ? `${(r.formulary_columns || ['Select', 'Premium'])[0]} ${r.select || '-'}; ${(r.formulary_columns || ['Select', 'Premium'])[1]} ${r.premium || '-'}` : `${r.tier_before} -> ${r.tier_after}`}${r.brand_generic ? ' | ' + r.brand_generic : ''} | ${Object.entries(r.flags || {}).filter(([, v]) => v).map(([k]) => k).join('/') || 'no flags'} | eff ${r.effective}`;
  if (r.kind === 'add_remove') return `${r.action} ${r.name} | eff ${r.effective}`;
  return `${r.category} | ${r.name}${r.generic ? ' (' + r.generic + ')' : ''} | ${r.tier || (r.coverage || '')} | ${(r.restrictions || []).join(', ')}`;
}

main();
