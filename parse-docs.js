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
  const cont = (t, soFar) => (/^\([a-z]/.test(t) && !hasGeneric(soFar)) || /^[\d.]+ ?(MG|ML|MCG|UNIT|UNT|%|X|GM|G)\b/i.test(t) || /^(MG|ML|MCG|UNIT|GM|G)\b/i.test(t) || (!/\(/.test(t) && /\)\s*$/.test(t)) || /^(INJECTOR|KWIKPEN|SOLOSTAR|FLEXTOUCH|FLEXPEN|PEN-INJECTOR|CARTRIDGE|AUTO-INJECTOR|SYRINGE|THERAPY PACK|PACK|DETERRENT|RELEASE)\b/i.test(t) || (/-$/.test(soFar.trim())) || (/^[a-z]/.test(t) && /^[^A-Z]*\)\s*$/.test(t) && parenBalance(soFar) > 0) || (parenBalance(soFar) > 0 && !/\(/.test(t));
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
    rows.push({ category, name, generic, tier, coverage: tier === 'NF' ? 'not covered' : 'listed', restrictions: restr, text: t });
  };
  for (const rawLine of lines) {
    const t = rawLine.trim();
    if (!t || BOOKLET_SKIP.test(t) || LEGEND_RE.test(t)) continue;
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
  let tierCol = -1, limitsCol = -1;
  for (let i = 0; i < raw.length; i++) {
    if (/Prescription Drug Name/.test(raw[i]) && /Drug Tier/.test(raw[i])) {
      tierCol = raw[i].indexOf('Drug Tier');
      if (/Limits/.test(raw[i])) limitsCol = raw[i].indexOf('Limits');
      else for (let j = i + 1; j <= i + 2 && j < raw.length; j++) if (/Limits/.test(raw[j])) { limitsCol = raw[j].indexOf('Limits'); break; }
      break;
    }
  }
  const columnMode = tierCol > 10;
  // Booklet-style guides carry a legend with PSP/NPSP codes; route them to the booklet parser even if a
  // "Drug Tier" header line appears somewhere in the front matter.
  if (/NPSP\s*=|PSP\s*=\s*Preferred Specialty/i.test(text) || (!columnMode && /PG\s*=\s*Preferred Generic/i.test(text))) return parseAetnaBooklet(text);
  if (columnMode && limitsCol <= tierCol) limitsCol = tierCol + 12;
  const rows = []; const problems = []; const notes = { columnMode, tierCol, limitsCol, unknownTierTokens: {} };
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
// Driver
// ---------------------------------------------------------------------------

function parserFor(id) {
  if (id.startsWith('aetna-')) return { name: 'aetna-guide', parse: parseAetna, diff: diffAetna };
  if (id.startsWith('optum-pharmacy-passages') || id.startsWith('optum-pp')) return { name: 'optum-passages', parse: parseOptum, diff: null };
  return null;
}

function tagWatch(row) {
  const h = watchHits(`${row.name || ''} ${row.generic || ''} ${row.category || ''}`);
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
      let parsed;
      if (fs.existsSync(outFile) && !FORCE) parsed = readJson(outFile, null);
      if (!parsed) {
        log(`Parsing ${id} ${v.stamp} with ${p.name}`);
        parsed = p.parse(fs.readFileSync(txt, 'utf8'));
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
  fs.writeFileSync(path.join(DATA_DIR, 'report.md'), lines.join('\n'));
  log('Wrote data/docs/report.md');
}

function rowLine(r) {
  const cut = (v, n = 160) => { const t = String(v == null ? '' : v); return t.length > n ? t.slice(0, n) + '…' : t; };
  if (r.name && String(r.name).length > 200) return `(oversized row, ${String(r.name).length} chars) ${cut(r.name)}`;
  if (r.kind === 'tier_change') return `${r.therapeutic_use ? r.therapeutic_use + ' | ' : ''}${r.name} | ${r.tier_before} -> ${r.tier_after}${r.brand_generic ? ' | ' + r.brand_generic : ''} | ${JSON.stringify(r.flags)} | eff ${r.effective}`;
  if (r.kind === 'add_remove') return `${r.action} ${r.name} | eff ${r.effective}`;
  return `${r.category} | ${r.name}${r.generic ? ' (' + r.generic + ')' : ''} | ${r.tier || (r.coverage || '')} | ${(r.restrictions || []).join(', ')}`;
}

main();
