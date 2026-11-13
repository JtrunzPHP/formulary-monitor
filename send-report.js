// send-report.js
// Emails what changed since the last email, via Resend.
//
// Sends an alert when any of these is new since the last send:
//   - a watched commercial document changed (data/docs/index.json last_change)
//   - a new Part D comparison exists (data/partd/diffs/index.json)
// The watchlist rows come first, then the rest. When nothing changed, it sends
// a short status note on Mondays only (MODE=heartbeat) so you know it is alive.
//
// State lives in data/alerts/state.json so the same change is never sent twice.
//
// Env: RESEND_API_KEY (required), ALERT_TO (required), ALERT_FROM (optional,
// default onboarding@resend.dev which works for unverified Resend accounts to
// the account owner's address), MODE (auto | heartbeat | test), SITE_URL.
// No npm packages. Node 20 or newer.

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const DOCS = path.join(ROOT, 'data', 'docs');
const PARTD = path.join(ROOT, 'data', 'partd');
const STATE_FILE = path.join(ROOT, 'data', 'alerts', 'state.json');
const SITE = process.env.SITE_URL || 'https://jtrunzphp.github.io/formulary-monitor/';
const MODE = (process.env.MODE || 'auto').toLowerCase();
const KEY = process.env.RESEND_API_KEY;
const TO = process.env.ALERT_TO;
const FROM = process.env.ALERT_FROM || 'Formulary Monitor <onboarding@resend.dev>';

function log(...a) { console.log(new Date().toISOString().slice(11, 19), ...a); }
function readJson(f, fb) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fb; } }
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
const fmt = (n) => Number(n || 0).toLocaleString();

// ---------------------------------------------------------------------------
// Gather what is new
// ---------------------------------------------------------------------------

function docEvents(state) {
  const index = readJson(path.join(DOCS, 'index.json'), { sources: {} });
  const structured = readJson(path.join(DOCS, 'structured.json'), { sources: {} });
  const events = [];
  for (const s of Object.values(index.sources || {})) {
    if (!s.last_change) continue;
    const sentStamp = (state.docs || {})[s.id];
    if (sentStamp && sentStamp >= s.last_change) continue;
    const change = readJson(path.join(DOCS, s.id, 'changes', `${s.last_change}.json`), null);
    const st = (structured.sources || {})[s.id] || {};
    const ev = { id: s.id, name: s.name, pbm: s.pbm, url: s.url, stamp: s.last_change, kind: change ? change.kind : 'unknown', watch: [], rows: [], linesAdded: 0, linesRemoved: 0 };
    if (change) {
      ev.linesAdded = change.lines_added || 0; ev.linesRemoved = change.lines_removed || 0;
      const hits = change.kind === 'baseline' ? (change.watchlist_in_document || []) : (change.watchlist_in_added || []).concat((change.watchlist_in_removed || []).map((h) => ({ ...h, removed: true })));
      ev.watchLines = hits.slice(0, 40);
    }
    // Structured rows: Optum issues are change tables; Aetna has a version diff
    if (st.parser === 'optum-passages' && Array.isArray(st.changes)) ev.rows = st.changes;
    else if (Array.isArray(st.latest_changes)) ev.rows = st.latest_changes;
    ev.watch = ev.rows.filter((r) => r.watch_tickers && r.watch_tickers.length);
    if (ev.kind === 'update' && !ev.linesAdded && !ev.linesRemoved && !ev.rows.length) continue;
    events.push(ev);
  }
  return events;
}

function partdEvent(state) {
  const index = readJson(path.join(PARTD, 'diffs', 'index.json'), { diffs: [] });
  if (!index.diffs.length) return null;
  const latest = index.diffs[index.diffs.length - 1];
  if (state.partd && state.partd.last_tag === latest.tag) return null;
  const summary = readJson(path.join(PARTD, 'diffs', `${latest.tag}.summary.json`), null);
  if (!summary) return null;
  const hasLives = !!summary.enrollment_period;
  const unit = hasLives ? 'lives' : 'plans';
  const all = (summary.top_changes || []);
  const matched = summary.plans_matched || 1;
  // "Universal" = touches effectively every matched plan: file-wide code or flag changes, not sponsor decisions.
  const universal = all.filter((x) => x.change === 'SELECTED_DRUG_FLAG_CHANGED' || (x.plans >= matched * 0.95));
  const ranked = all.filter((x) => !universal.includes(x)).sort((a, b) => (hasLives ? b.lives - a.lives : b.plans - a.plans));
  const watchTickers = ['DXCM', 'ABT', 'PODD', 'TNDM', 'MDT', 'NVO', 'LLY', 'RMD', 'PHG'];
  const byMfr = (hasLives && summary.by_manufacturer_lives_affected) || summary.by_manufacturer_plans_affected || {};
  const watchMfr = Object.entries(byMfr).filter(([t]) => watchTickers.includes(t)).map(([t, x]) => ({ ticker: t, ...x }));
  return { tag: latest.tag, summary, ranked, universal, watchMfr, unit };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function cleanName(r) { return String(r.name || '').replace(/\*+$/, '').trim(); }
function usable(r) {
  // Drop rows the parser could not read well enough to act on.
  const n = cleanName(r);
  if (!n || n.length < 4 || !/[A-Za-z]{3}/.test(n)) return false;
  if (r.kind === 'tier_change' && !r.tier_before && !r.tier_after) return false;
  if (/^(Tier|Tie|name|use|N\/A)\b/i.test(n)) return false;
  return true;
}
function umList(r) { return ['PA', 'ST', 'QL'].filter((k) => r.flags && r.flags[k]); }
function bucket(r) {
  // exclusion | restriction | tier_down | tier_up | added | removed | other
  if (r.kind === 'add_remove') return r.action === 'Remove' ? 'removed' : 'added';
  if (r.change) { // Aetna diff rows
    if (r.change === 'REMOVED' || (r.tier_after || '').toUpperCase() === 'NF') return 'exclusion';
    if (r.change === 'ADDED') return 'added';
    if (r.change === 'RESTRICTION_CHANGED') return (r.restrictions_after || []).length > (r.restrictions_before || []).length ? 'restriction' : 'other';
    if (r.change === 'TIER_CHANGED') return 'tier';
    return 'other';
  }
  const a = (r.tier_after || '').toUpperCase(), b = (r.tier_before || '').toUpperCase();
  if (/EXC|N\/C/.test(a)) return 'exclusion';
  if (b && a && b !== a) return 'tier';
  if (umList(r).length) return 'restriction';
  return 'added';
}
const BUCKET_TITLES = { exclusion: 'Exclusions and coverage losses', removed: 'Removed from formulary', restriction: 'New or continuing restrictions (PA, ST, QL)', tier: 'Tier changes', added: 'Additions and new coverage', other: 'Other' };
const BUCKET_ORDER = ['exclusion', 'removed', 'restriction', 'tier', 'added', 'other'];

function sentence(r) {
  const n = cleanName(r);
  const cls = r.therapeutic_use || r.category ? ` <span style="color:#536270">(${esc(r.therapeutic_use || r.category)})</span>` : '';
  const eff = r.effective ? `, effective ${esc(r.effective)}` : '';
  if (r.kind === 'tier_change') {
    const um = umList(r); const a = r.tier_after || '', b = r.tier_before || '';
    let what;
    if (/EXC|N\/C/i.test(a)) what = `excluded${b && !/EXC|N\/C/i.test(b) ? ` (was ${esc(b)})` : ''}`;
    else if (b && a && b !== a) what = `moved from ${esc(b)} to ${esc(a)}`;
    else what = `${esc(a || b || 'covered')}`;
    return `<b>${esc(n)}</b>${cls}: ${what}${um.length ? `, ${um.join(', ')}` : ''}${r.brand_generic ? ` <span style="color:#536270">${esc(r.brand_generic)}</span>` : ''}${eff}`;
  }
  if (r.kind === 'add_remove') return `<b>${esc(n)}</b>${cls}: ${r.action === 'Remove' ? 'removed' : 'added'}${eff}`;
  const ra = (r.restrictions_after || []).join(', '), rb = (r.restrictions_before || []).join(', ');
  const g = r.generic ? ` <span style="color:#536270">(${esc(r.generic)})</span>` : '';
  if (r.change === 'ADDED') return `<b>${esc(n)}</b>${g}${cls}: added as ${esc(r.tier_after || 'listed')}${ra ? `, ${esc(ra)}` : ''}`;
  if (r.change === 'REMOVED') return `<b>${esc(n)}</b>${g}${cls}: removed (was ${esc(r.tier_before || 'listed')})`;
  if (r.change === 'TIER_CHANGED') return `<b>${esc(n)}</b>${g}${cls}: ${esc(r.tier_before || 'listed')} to ${esc(r.tier_after || 'listed')}${ra ? `, ${esc(ra)}` : ''}`;
  if (r.change === 'RESTRICTION_CHANGED') return `<b>${esc(n)}</b>${g}${cls}: restrictions ${esc(rb || 'none')} to ${esc(ra || 'none')}`;
  return `<b>${esc(n)}</b>: ${esc(r.change || '')}`;
}

function buildHtml(docEvs, pd, heartbeat) {
  const h = [];
  const style = 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.5;color:#16202a;max-width:760px;';
  const H2 = (t) => `<h2 style="font-size:16px;margin:22px 0 6px;border-bottom:1px solid #dbe1e6;padding-bottom:4px">${t}</h2>`;
  const H3 = (t) => `<h3 style="font-size:14px;margin:12px 0 4px;color:#536270;font-weight:600">${t}</h3>`;
  const UL = (items) => `<ul style="padding-left:18px;margin:0 0 8px">${items.map((i) => `<li style="margin:2px 0">${i}</li>`).join('')}</ul>`;
  h.push(`<div style="${style}">`);
  if (heartbeat) h.push(`<p>No formulary changes since the last alert. All sources were checked on schedule.</p>`);

  // ---- Summary line ----
  const docsWithRows = docEvs.filter((e) => e.rows.some(usable));
  const totalRows = docEvs.reduce((n, e) => n + e.rows.filter(usable).length, 0);
  if (docEvs.length || pd) {
    const bits = [];
    if (docsWithRows.length) bits.push(`${docsWithRows.length} commercial document${docsWithRows.length > 1 ? 's' : ''} with ${fmt(totalRows)} readable changes`);
    if (pd) bits.push(`a new Medicare Part D comparison (${esc(pd.summary.prev)} to ${esc(pd.summary.latest)})`);
    h.push(`<p style="margin:0 0 6px">${bits.join(' and ')}. Watchlist items are listed first; the full tables are on the <a href="${esc(SITE)}">dashboard</a>.</p>`);
  }

  // ---- Watchlist ----
  const watchItems = [];
  for (const ev of docEvs) for (const r of ev.watch.filter(usable)) watchItems.push({ src: ev, r });
  if (watchItems.length || (pd && pd.watchMfr.length)) {
    h.push(H2('Watchlist'));
    if (watchItems.length) {
      const byT = new Map();
      for (const it of watchItems) { const k = (it.r.watch_tickers || []).join(' ') || 'other'; if (!byT.has(k)) byT.set(k, []); byT.get(k).push(it); }
      for (const [t, items] of [...byT.entries()].sort()) h.push(H3(esc(t)), UL(items.slice(0, 25).map(({ src, r }) => `${sentence(r)} <span style="color:#536270">[${esc(src.pbm)}: ${esc(src.name)}]</span>`)));
    }
    if (pd && pd.watchMfr.length) {
      h.push(H3(`Medicare Part D, ${esc(pd.summary.prev)} to ${esc(pd.summary.latest)} (${pd.unit})`));
      h.push(UL(pd.watchMfr.map((m) => { const keys = ['REMOVED', 'PA_ADDED', 'ST_ADDED', 'QL_ADDED', 'TIER_UP', 'ADDED', 'TIER_DOWN']; const parts = keys.filter((k) => m[k]).map((k) => `${fmt(m[k])} ${k.replace(/_/g, ' ').toLowerCase()}`); return `<b>${esc(m.ticker)}</b> ${esc(m.parent || '')}: ${esc(parts.join('; ') || 'no coverage events')}`; })));
    }
  }

  // ---- Commercial documents, grouped by what the change means ----
  for (const ev of docEvs) {
    const rows = ev.rows.filter(usable);
    const unread = ev.rows.length - rows.length;
    if (!rows.length && ev.kind !== 'baseline' && !(ev.linesAdded || ev.linesRemoved)) continue;
    h.push(H2(`${esc(ev.name)} <span style="font-weight:400;color:#536270">${esc(ev.pbm)}</span>`));
    h.push(`<p style="margin:0 0 6px;color:#536270">${ev.kind === 'baseline' ? 'First capture of this document.' : `Document updated: ${fmt(ev.linesAdded)} lines added, ${fmt(ev.linesRemoved)} removed.`} <a href="${esc(ev.url)}">Source</a>${unread ? ` · ${fmt(unread)} rows could not be read cleanly and are on the site only` : ''}</p>`);
    const groups = new Map();
    for (const r of rows) { if (r.watch_tickers && r.watch_tickers.length) continue; const b = bucket(r); if (!groups.has(b)) groups.set(b, []); groups.get(b).push(r); }
    for (const b of BUCKET_ORDER) {
      const list = groups.get(b); if (!list || !list.length) continue;
      h.push(H3(`${BUCKET_TITLES[b]} (${fmt(list.length)})`));
      h.push(UL(list.slice(0, 20).map(sentence).concat(list.length > 20 ? [`<span style="color:#536270">and ${fmt(list.length - 20)} more on the site</span>`] : [])));
    }
  }

  // ---- Part D ----
  if (pd) {
    const s = pd.summary; const t = s.by_type || {};
    h.push(H2(`Medicare Part D: ${esc(s.prev)} to ${esc(s.latest)}`));
    h.push(`<p style="margin:0 0 6px;color:#536270">Contract year ${esc(s.contract_year_prev)} to ${esc(s.contract_year_latest)}${s.new_plan_year ? ' (annual reset)' : ''}. ${fmt(s.plans_matched)} plans matched${s.enrollment_period ? `, weighted by CMS enrollment for ${esc(s.enrollment_period)}` : ''}. Removed ${fmt(t.REMOVED)}, added ${fmt(t.ADDED)}, PA added ${fmt(t.PA_ADDED)}, ST added ${fmt(t.ST_ADDED)}, QL added ${fmt(t.QL_ADDED)}, tier moves ${fmt((t.TIER_UP || 0) + (t.TIER_DOWN || 0))} (plan-level events).</p>`);
    const line = (x) => `<b>${esc(x.drug)}</b> <span style="color:#536270">[${esc(x.labeler)}${x.mfr_ticker ? ', ' + esc(x.mfr_ticker) : ''}]</span>: ${fmt(x.lives || x.plans)} ${pd.unit} across ${fmt(x.transitions)} formularies${x.lives_parents && x.lives_parents.length ? ` <span style="color:#536270">(${esc(x.lives_parents.slice(0, 3).join('; '))})</span>` : ''}`;
    const sections = [['Coverage losses', (x) => x.change === 'REMOVED'], ['New restrictions', (x) => /^(PA|ST|QL)_ADDED$/.test(x.change)], ['Tier moves up (worse)', (x) => x.change === 'TIER_UP'], ['Additions', (x) => x.change === 'ADDED'], ['Tier moves down (better)', (x) => x.change === 'TIER_DOWN']];
    for (const [title, f] of sections) {
      const list = pd.ranked.filter(f).slice(0, 10);
      if (!list.length) continue;
      h.push(H3(title), UL(list.map(line)));
    }
    if (pd.universal.length) h.push(H3('Changes on effectively every plan (file-wide, usually code or negotiated-price flag changes rather than sponsor decisions)'), UL(pd.universal.slice(0, 12).map((x) => `${esc(x.change.replace(/_/g, ' ').toLowerCase())}: ${esc(x.drug)}`)));
  }
  h.push(`<p style="margin-top:18px;color:#536270">Dashboard: <a href="${esc(SITE)}">${esc(SITE)}</a></p></div>`);
  return h.join('\n');
}

// ---------------------------------------------------------------------------
// Send
// ---------------------------------------------------------------------------

async function send(subject, html) {
  if (!KEY || !TO) throw new Error('RESEND_API_KEY and ALERT_TO must be set as repository secrets');
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ from: FROM, to: TO.split(',').map((s) => s.trim()).filter(Boolean), subject, html }) });
  const body = await res.text();
  if (!res.ok) throw new Error(`Resend returned ${res.status}: ${body}`);
  log(`Sent: ${subject} (${body.slice(0, 120)})`);
}

async function main() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const state = readJson(STATE_FILE, { docs: {}, partd: {}, last_sent: null });

  if (MODE === 'test') {
    await send('Formulary Monitor test', `<p>This is a test from the formulary monitor. Dashboard: <a href="${esc(SITE)}">${esc(SITE)}</a></p>`);
    return;
  }

  const docEvs = docEvents(state);
  const pd = partdEvent(state);
  const nothing = !docEvs.length && !pd;
  log(`Document events: ${docEvs.length}; Part D new comparison: ${pd ? pd.tag : 'none'}`);

  if (nothing) {
    if (MODE === 'heartbeat') {
      await send('Formulary Monitor: no changes this week', buildHtml([], null, true));
      state.last_sent = new Date().toISOString();
      fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
    } else log('Nothing new; no email sent.');
    return;
  }

  const watchCount = docEvs.reduce((n, e) => n + e.watch.filter(usable).length, 0) + (pd && pd.watchMfr.length ? 1 : 0);
  const parts = [];
  if (docEvs.length) parts.push(`${docEvs.length} document${docEvs.length > 1 ? 's' : ''} changed`);
  if (pd) parts.push(`new Part D comparison ${pd.summary.prev} to ${pd.summary.latest}`);
  const subject = `Formulary Monitor: ${watchCount ? `${watchCount} watchlist item${watchCount > 1 ? 's' : ''}, ` : ''}${parts.join(', ')}`;
  await send(subject, buildHtml(docEvs, pd, false));

  for (const ev of docEvs) state.docs[ev.id] = ev.stamp;
  if (pd) state.partd = { last_tag: pd.tag };
  state.last_sent = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

main().catch((e) => { console.error('SEND FAILED:', e.message); process.exit(1); });
