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
  const top = (summary.top_changes || []).filter((x) => x.change !== 'SELECTED_DRUG_FLAG_CHANGED').slice(0, 15);
  const watchTickers = ['DXCM', 'ABT', 'PODD', 'TNDM', 'MDT', 'NVO', 'LLY', 'RMD', 'PHG'];
  const byMfr = summary.by_manufacturer_plans_affected || {};
  const watchMfr = Object.entries(byMfr).filter(([t]) => watchTickers.includes(t)).map(([t, x]) => ({ ticker: t, ...x }));
  return { tag: latest.tag, summary, top, watchMfr };
}

// ---------------------------------------------------------------------------
// Render
// ---------------------------------------------------------------------------

function rowSentence(r) {
  if (r.kind === 'tier_change') {
    const um = ['SP', 'PA', 'ST', 'QL'].filter((k) => r.flags && r.flags[k]).join('/');
    const tiers = r.tier_before && r.tier_after && r.tier_before !== r.tier_after ? `${r.tier_before} to ${r.tier_after}` : (r.tier_after || r.tier_before || 'tier not read');
    return `${r.name}${r.therapeutic_use ? ` (${r.therapeutic_use})` : ''}: ${tiers}${um ? `, ${um}` : ''}, effective ${r.effective}`;
  }
  if (r.kind === 'add_remove') return `${r.name}: ${r.action === 'Remove' ? 'removed from formulary' : 'added to formulary'}, effective ${r.effective}`;
  // Aetna diff rows
  const b = r.tier_before || (r.restrictions_before ? 'listed' : ''); const a = r.tier_after || (r.restrictions_after ? 'listed' : '');
  const ra = r.restrictions_after && r.restrictions_after.length ? ` [${r.restrictions_after.join(', ')}]` : '';
  if (r.change === 'ADDED') return `${r.name}${r.generic ? ` (${r.generic})` : ''}: added as ${a || 'listed'}${ra}`;
  if (r.change === 'REMOVED') return `${r.name}${r.generic ? ` (${r.generic})` : ''}: removed (was ${b || 'listed'})`;
  if (r.change === 'TIER_CHANGED') return `${r.name}${r.generic ? ` (${r.generic})` : ''}: ${b} to ${a}${ra}`;
  if (r.change === 'RESTRICTION_CHANGED') return `${r.name}${r.generic ? ` (${r.generic})` : ''}: restrictions ${(r.restrictions_before || []).join(', ') || 'none'} to ${(r.restrictions_after || []).join(', ') || 'none'}`;
  return `${r.name}: ${r.change}`;
}

function buildHtml(docEvs, pd, heartbeat) {
  const h = [];
  const style = 'font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.45;color:#16202a;';
  h.push(`<div style="${style}">`);
  if (heartbeat) {
    h.push(`<p>No formulary changes since the last alert. The monitor is running; sources were checked on schedule.</p>`);
  }
  // Watchlist first
  const watchItems = [];
  for (const ev of docEvs) for (const r of ev.watch) watchItems.push({ src: ev, r });
  if (watchItems.length || (pd && pd.watchMfr.length)) {
    h.push(`<h2 style="font-size:16px;margin:18px 0 6px">Watchlist</h2>`);
    if (watchItems.length) {
      h.push('<ul style="padding-left:18px;margin:0 0 10px">');
      for (const { src, r } of watchItems.slice(0, 60)) h.push(`<li><b>${esc((r.watch_tickers || []).join(' '))}</b> ${esc(rowSentence(r))} <span style="color:#536270">(${esc(src.name)})</span></li>`);
      h.push('</ul>');
    }
    if (pd && pd.watchMfr.length) {
      h.push(`<p style="margin:0 0 6px">Medicare Part D, ${esc(pd.summary.prev)} to ${esc(pd.summary.latest)}, plan-level events by manufacturer ticker:</p><ul style="padding-left:18px;margin:0 0 10px">`);
      for (const m of pd.watchMfr) { const parts = Object.entries(m).filter(([k, v]) => !['ticker', 'parent'].includes(k) && v).map(([k, v]) => `${fmt(v)} ${k.replace(/_/g, ' ').toLowerCase()}`); h.push(`<li><b>${esc(m.ticker)}</b> ${esc(m.parent || '')}: ${esc(parts.join('; '))}</li>`); }
      h.push('</ul>');
    }
  }
  // Documents
  for (const ev of docEvs) {
    h.push(`<h2 style="font-size:16px;margin:18px 0 6px">${esc(ev.name)} <span style="font-weight:400;color:#536270">${esc(ev.pbm)}</span></h2>`);
    h.push(`<p style="margin:0 0 6px;color:#536270">${ev.kind === 'baseline' ? 'First capture of this document.' : `Document updated: ${fmt(ev.linesAdded)} lines added, ${fmt(ev.linesRemoved)} removed.`} <a href="${esc(ev.url)}">Source</a></p>`);
    const others = ev.rows.filter((r) => !(r.watch_tickers && r.watch_tickers.length));
    if (others.length) {
      h.push('<ul style="padding-left:18px;margin:0 0 10px">');
      for (const r of others.slice(0, 40)) h.push(`<li>${esc(rowSentence(r))}</li>`);
      if (others.length > 40) h.push(`<li style="color:#536270">and ${fmt(others.length - 40)} more on the site</li>`);
      h.push('</ul>');
    } else if (ev.kind !== 'baseline' && ev.watchLines && ev.watchLines.length) {
      h.push('<ul style="padding-left:18px;margin:0 0 10px">');
      for (const l of ev.watchLines.slice(0, 20)) h.push(`<li>${l.removed ? 'Removed line' : 'New line'}: ${esc(l.text)}</li>`);
      h.push('</ul>');
    }
  }
  // Part D
  if (pd) {
    const s = pd.summary; const t = s.by_type || {};
    h.push(`<h2 style="font-size:16px;margin:18px 0 6px">Medicare Part D: ${esc(s.prev)} to ${esc(s.latest)}</h2>`);
    h.push(`<p style="margin:0 0 6px;color:#536270">Contract year ${esc(s.contract_year_prev)} to ${esc(s.contract_year_latest)}${s.new_plan_year ? ' (annual reset)' : ''}. ${fmt(s.plans_matched)} plans matched. Removed ${fmt(t.REMOVED)}, added ${fmt(t.ADDED)}, PA added ${fmt(t.PA_ADDED)}, ST added ${fmt(t.ST_ADDED)}, QL added ${fmt(t.QL_ADDED)}, tier moves ${fmt((t.TIER_UP || 0) + (t.TIER_DOWN || 0))}.</p>`);
    h.push('<p style="margin:0 0 4px">Widest changes by plans affected:</p><ul style="padding-left:18px;margin:0 0 10px">');
    for (const x of pd.top) h.push(`<li>${esc(x.change.replace(/_/g, ' ').toLowerCase())}: ${esc(x.drug)} [${esc(x.labeler)}${x.mfr_ticker ? ', ' + esc(x.mfr_ticker) : ''}], ${fmt(x.plans)} plans across ${fmt(x.transitions)} formularies</li>`);
    h.push('</ul>');
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

  const watchCount = docEvs.reduce((n, e) => n + e.watch.length, 0) + (pd && pd.watchMfr.length ? 1 : 0);
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
