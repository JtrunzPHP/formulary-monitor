// checks.js
// Known-answer tests for the document parsers. Each entry names a document,
// a product (matched case-insensitively against the parsed product name) and
// what the parsed row must say. parse-docs.js runs every check after parsing
// and marks a document "untrusted" if any of its checks fail; untrusted rows
// are kept in the data but held out of the email and flagged on the site.
//
// Add a check whenever you confirm a fact by reading the PDF. Keep the
// expectation to what the document literally shows.
//
// Fields:
//   source   document id (as in sources.js or the discovered id)
//   product  substring of the product name to find (first match wins)
//   expect   object of row fields and the value they must contain:
//            tier (Aetna guide), select / premium / flags (Optum), change (Aetna SOC), kind, drug_class (ESI)
//   note     where in the PDF this was confirmed

const CHECKS = [
  // ---- Aetna Advanced Control guides (read from the diabetic supplies pages, confirmed 2026-11-13 from the parse log; re-confirm by eye) ----
  { source: 'aetna-acp-2027', product: 'DEXCOM G7 SENSOR', expect: { tier: 'NF' }, note: '2027 guide, DIABETIC SUPPLIES' },
  { source: 'aetna-acp-2027', product: 'FREESTYLE LIBRE 3 PLUS SENSOR', expect: { tier: 'PB' }, note: '2027 guide, DIABETIC SUPPLIES' },
  { source: 'aetna-acp-2027', product: 'OZEMPIC (1 MG/DOSE)', expect: { tier: 'PB' }, note: '2027 guide, INCRETIN MIMETICS' },
  { source: 'aetna-acp-2027', product: 'VICTOZA', expect: { tier: 'NF' }, note: '2027 guide, INCRETIN MIMETICS' },
  { source: 'aetna-acp-2026', product: 'DEXCOM G7 SENSOR', expect: { tier: 'PB' }, note: '2026 guide, DIABETIC SUPPLIES' },
  { source: 'aetna-acp-2026', product: 'FREESTYLE LIBRE 3 PLUS SENSOR', expect: { tier: 'NF' }, note: '2026 guide, DIABETIC SUPPLIES' },
  { source: 'aetna-acp-2026', product: 'ACCU-CHEK GUIDE TEST', expect: { tier: 'PB' }, note: '2026 guide, DIABETIC SUPPLIES' },

  // ---- Optum Pharmacy Passages ----
  { source: 'optum-pharmacy-passages-sep-2025', product: 'Dexcom G7 15-day', expect: { select: 'Tier 2', premium: 'Tier 2', flags: { PA: true } }, note: 'Sept 2025 issue, new brand coverage table' },
  { source: 'optum-pharmacy-passages-sep-2025', product: 'Freestyle glucose blood test strips', expect: { kind: 'tier_change' }, note: 'Sept 2025 issue, exclusions table, Brand 3>2 EXC 9/15/25' },
  { source: 'optum-pharmacy-passages-direct-umr-april-2026', product: 'Insulin glargine (ABA of Toujeo)', expect: { kind: 'tier_change' }, note: 'April 2026 Direct UMR issue, effective 5/1/26' },

  // ---- Aetna Summary of Changes notices (the ids are produced by the probe: aetna-soc-acp-YYYYMMDD) ----
  { source: 'aetna-soc-acp-20260101', product: 'MOBI 2ML CARTRIDGE', expect: { change: 'NOT_COVERED' }, note: 'SOC for 01.01.26 Advanced Control: Non-formulary; covered options Omnipod 5/Dash, Twiist' },
  { source: 'aetna-soc-acp-20260101', product: 'AUTOSOFT', expect: { change: 'NOT_COVERED' }, note: 'SOC for 01.01.26 Advanced Control' },
  { source: 'aetna-soc-acp-20260101', product: 'MITIGARE', expect: { change: 'NOT_COVERED' }, note: 'SOC for 01.01.26 Advanced Control' },

  // ---- Express Scripts exclusion lists ----
  { source: 'esi-npf-changes-jan-2026', product: 'ONETOUCH', expect: { kind: 'exclusion' }, note: '2026 NPF exclusion changes: OneTouch supplies removed (per the notice; confirm the product line)' },
];

module.exports = { CHECKS };
