// sources.js
// Documents the commercial collector watches.
//
// Fields:
//   id        short unique name, used as the folder under data/docs/
//   pbm       which PBM the document belongs to
//   owner     who hosts it (so a broken link is easy to trace)
//   name      human-readable title for the report
//   url       direct link to the document (pdf, xlsx or html)
//   kind      'pdf' | 'xlsx' | 'html' | 'probe'
//   family    documents of the same family are compared edition to edition (see parse-docs)
//   parser    which structured parser to use: 'aetna-guide' | 'aetna-soc' | 'esi-exclusions' | 'optum-passages' | 'none'
//   cadence   when the publisher usually changes it
//   verified  'yes' if the URL was confirmed when added; 'inferred' if the pattern was extrapolated; 'client copy'
//             if hosted by a plan sponsor rather than the PBM (the content is the PBM's document)
//
// kind 'html' with `discover` reads links off an index page and tracks every match.
// kind 'probe' generates candidate URLs from a template and a date list and tracks the ones that exist.
//   template: use {MM} {DD} {YY} {YYYY} placeholders; dates: 'quarters' (next and previous eight quarter starts),
//   'halves' (Jan 1 and Jul 1), 'years' (Jan 1), or an explicit array of 'YYYY-MM-DD'.

const SOURCES = [
  // ---- CVS Caremark / Aetna: the drug guides (full formularies) ----
  { id: 'aetna-acp-2027', pbm: 'CVS Caremark', owner: 'Aetna via formularynavigator.com', name: '2027 Advanced Control Plan, Aetna', url: 'https://fm.formularynavigator.com/FBO/41/2027_Advanced_Control_Plan_Aetna.pdf', kind: 'pdf', family: 'aetna-acp', parser: 'aetna-guide', cadence: 'updated the first week of each month', verified: 'yes' },
  { id: 'aetna-acp-2026', pbm: 'CVS Caremark', owner: 'Aetna via formularynavigator.com', name: '2026 Advanced Control Plan, Aetna', url: 'https://fm.formularynavigator.com/FBO/41/2026_Advanced_Control_Plan_Aetna.pdf', kind: 'pdf', family: 'aetna-acp', parser: 'aetna-guide', cadence: 'monthly', verified: 'inferred' },
  // Aetna's own document library carries the official editions of the same guide.
  { id: 'aetna-acp-official-2027', pbm: 'CVS Caremark', owner: 'aetna.com document library', name: '2027 Advanced Control Plan drug guide (aetna.com)', url: 'https://www.aetna.com/content/dam/aetna/pdfs/aetnacom/individuals-families-health-insurance/document-library/pharmacy/2027_Drug_guide_Advanced_Control.pdf', kind: 'pdf', family: 'aetna-acp-official', parser: 'aetna-guide', cadence: 'monthly', verified: 'yes' },
  { id: 'aetna-acp-official-2026', pbm: 'CVS Caremark', owner: 'aetna.com document library', name: '2026 Advanced Control Plan drug guide (aetna.com)', url: 'https://www.aetna.com/content/dam/aetna/pdfs/aetnacom/individuals-families-health-insurance/document-library/pharmacy/2026_Advanced_Control_Plan_Aetna_01012026.pdf', kind: 'pdf', family: 'aetna-acp-official', parser: 'aetna-guide', cadence: 'monthly', verified: 'yes' },
  { id: 'aetna-scc-exclusions-2026', pbm: 'CVS Caremark', owner: 'aetna.com document library', name: '2026 Formulary Exclusions, Standard Control Choice with ACSF', url: 'https://www.aetna.com/content/dam/aetna/pdfs/aetnacom/individuals-families-health-insurance/document-library/pharmacy/2026-exclusions-drug-list-standard-control-choice-wACSF.pdf', kind: 'pdf', parser: 'none', cadence: 'quarterly', verified: 'yes' },

  // ---- CVS Caremark / Aetna: quarterly Summary of Changes notices (effective dates 1/1, 4/1, 7/1, 10/1) ----
  // Two-column tables of DRUG NAME | CHANGES with the decision in plain English. Probed by quarter.
  { id: 'aetna-soc-advanced-control', pbm: 'CVS Caremark', owner: 'aetna.com document library', name: 'Aetna Advanced Control: Summary of Changes', kind: 'probe', parser: 'aetna-soc', cadence: 'quarterly',
    probe: { templates: ['https://www.aetna.com/content/dam/aetna/pdfs/aetnacom/individuals-families-health-insurance/document-library/pharmacy/SOC-for-{MM}.{DD}.{YY}-Advanced-Control-Aetna.pdf', 'https://www.aetna.com/content/dam/aetna/pdfs/aetnacom/individuals-families-health-insurance/document-library/pharmacy/SOC-for-{MM}.{DD}.{YY}-Advanced-Control.pdf', 'https://www.aetna.com/pharmacy/JAN27QNOC_SOCs/SOC_for_{MM}_{DD}_{YY}_Advanced_Control_Aetna.pdf'], dates: 'quarters', idPrefix: 'aetna-soc-acp-', namePrefix: 'Aetna Advanced Control changes effective ' } },
  { id: 'aetna-soc-standard-control', pbm: 'CVS Caremark', owner: 'aetna.com document library', name: 'Aetna Standard Control: Summary of Changes', kind: 'probe', parser: 'aetna-soc', cadence: 'quarterly',
    probe: { templates: ['https://www.aetna.com/content/dam/aetna/pdfs/aetnacom/individuals-families-health-insurance/document-library/pharmacy/SOC-for-{MM}.{DD}.{YY}-Standard-Control.pdf'], dates: 'quarters', idPrefix: 'aetna-soc-sc-', namePrefix: 'Aetna Standard Control changes effective ' } },
  { id: 'aetna-soc-standard-control-choice', pbm: 'CVS Caremark', owner: 'aetna.com document library', name: 'Aetna Standard Control Choice with ACSF: Summary of Changes', kind: 'probe', parser: 'aetna-soc', cadence: 'quarterly',
    probe: { templates: ['https://www.aetna.com/content/dam/aetna/pdfs/aetnacom/individuals-families-health-insurance/document-library/pharmacy/SOC-for-{MM}.{DD}.{YY}-Standard-Control-Choice-with-ACSF.pdf'], dates: 'quarters', idPrefix: 'aetna-soc-scc-', namePrefix: 'Aetna Standard Control Choice changes effective ' } },
  { id: 'aetna-soc-advanced-control-modified-um', pbm: 'CVS Caremark', owner: 'aetna.com document library', name: 'Aetna Advanced Control (Modified PA and ST): Summary of Changes', kind: 'probe', parser: 'aetna-soc', cadence: 'quarterly',
    probe: { templates: ['https://www.aetna.com/content/dam/aetna/pdfs/aetnacom/individuals-families-health-insurance/document-library/pharmacy/SOC-for-{MM}.{DD}.{YY}-Advanced-Control-Modified-Prior-Authorization-and-Step-therapy.pdf'], dates: 'quarters', idPrefix: 'aetna-soc-acpum-', namePrefix: 'Aetna Advanced Control (Modified UM) changes effective ' } },

  // ---- Express Scripts / Evernorth ----
  // Full exclusion lists for the current year (stable short links), and the change notices for the next cycle.
  { id: 'esi-npf-exclusions-2026', pbm: 'Express Scripts', owner: 'express-scripts.com', name: '2026 National Preferred Formulary exclusions (full list)', url: 'https://express-scripts.com/2026drugs', kind: 'pdf', family: 'esi-npf-exclusions', parser: 'esi-exclusions', cadence: 'updated through the year', verified: 'yes' },
  { id: 'esi-npf-flex-exclusions-2026', pbm: 'Express Scripts', owner: 'express-scripts.com', name: '2026 National Preferred Flex Formulary exclusions (full list)', url: 'https://express-scripts.com/2026flex', kind: 'pdf', family: 'esi-flex-exclusions', parser: 'esi-exclusions', cadence: 'updated through the year', verified: 'yes' },
  { id: 'esi-npf-exclusions-2027', pbm: 'Express Scripts', owner: 'express-scripts.com', name: '2027 National Preferred Formulary exclusions (full list)', url: 'https://express-scripts.com/2027drugs', kind: 'pdf', family: 'esi-npf-exclusions', parser: 'esi-exclusions', cadence: 'posted around year end', verified: 'inferred' },
  { id: 'esi-npf-flex-exclusions-2027', pbm: 'Express Scripts', owner: 'express-scripts.com', name: '2027 National Preferred Flex Formulary exclusions (full list)', url: 'https://express-scripts.com/2027flex', kind: 'pdf', family: 'esi-flex-exclusions', parser: 'esi-exclusions', cadence: 'posted around year end', verified: 'inferred' },
  { id: 'esi-npf-changes-jan-2027', pbm: 'Express Scripts', owner: 'Evernorth', name: 'National Preferred Formulary exclusion changes effective January 1, 2027', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/2027%20NPF%20Exclusion%20Changes.pdf?version=0', kind: 'pdf', parser: 'esi-exclusions', cadence: 'January and July', verified: 'yes' },
  { id: 'esi-flex-changes-jan-2027', pbm: 'Express Scripts', owner: 'Evernorth', name: 'National Preferred Flex Formulary exclusion changes effective January 1, 2027', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/2027%20Flex%20Exclusion%20Changes.pdf?version=0', kind: 'pdf', parser: 'esi-exclusions', cadence: 'January and July', verified: 'yes' },
  { id: 'esi-basic-hpf-changes-jan-2027', pbm: 'Express Scripts', owner: 'Evernorth', name: 'Basic and High Performance Formulary status updates effective January 1, 2027', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/2027%20Basic%20and%20HPF%20changes%20for%20early%20send.pdf?version=0', kind: 'pdf', parser: 'none', cadence: 'January and July', verified: 'yes' },
  { id: 'esi-npf-changes-jul-2026', pbm: 'Express Scripts', owner: 'Evernorth', name: 'National Preferred Formulary exclusion changes effective July 1, 2026', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/NPF%207.1.26%20Changes.pdf?version=0', kind: 'pdf', parser: 'esi-exclusions', cadence: 'January and July', verified: 'yes' },
  { id: 'esi-npf-changes-jan-2026', pbm: 'Express Scripts', owner: 'Evernorth', name: 'National Preferred Formulary exclusion changes effective January 1, 2026', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/2026%20NPF%20Changes.250806.pdf?version=0', kind: 'pdf', parser: 'esi-exclusions', cadence: 'January and July', verified: 'yes' },
  { id: 'esi-npf-flex-changes-jan-2026', pbm: 'Express Scripts', owner: 'Evernorth', name: 'National Preferred Flex Formulary exclusion changes effective January 1, 2026', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/2026%20NPF%20Flex%20Changes.250806.pdf?version=0', kind: 'pdf', parser: 'esi-exclusions', cadence: 'January and July', verified: 'yes' },
  // Evernorth's consultant page links each new change notice; new PDFs on it are tracked automatically.
  { id: 'esi-consultant-updates-page', pbm: 'Express Scripts', owner: 'evernorth.com', name: 'Evernorth formulary updates page (consultant)', url: 'https://www.evernorth.com/consultant-2026-annualformularyupdates', kind: 'html', parser: 'none', cadence: 'January and July', verified: 'yes',
    discover: { pattern: /my\.comms\.evernorth\.com[^"']*\.pdf[^"']*/i, idPrefix: 'esi-', namePrefix: 'Express Scripts: ', pbm: 'Express Scripts', kind: 'pdf', cadence: 'January and July', parser: 'esi-exclusions' } },

  // ---- Optum Rx ----
  { id: 'optum-formulary-updates-page', pbm: 'Optum Rx', owner: 'business.optum.com', name: 'Optum Rx formulary and UM updates page (Pharmacy Passages index)', url: 'https://business.optum.com/en/support/hcp-resources/formulary-updates.html', kind: 'html', parser: 'none', cadence: 'monthly', verified: 'yes',
    discover: { pattern: /passages[^"']*\.pdf|formulary[^"']*updates[^"']*\.(pdf|xlsx)/i, idPrefix: 'optum-', namePrefix: 'Optum Rx: ', pbm: 'Optum Rx', kind: 'pdf', cadence: 'monthly', parser: 'optum-passages' } },
  { id: 'optum-pharmacy-passages-sep-2025', pbm: 'Optum Rx', owner: 'business.optum.com', name: 'Pharmacy Passages, September 2025 (Jan 2026 cycle)', url: 'https://business.optum.com/content/dam/noindex-resources/consumers/pdfs/forms/PharmacyPassages-September-2025.pdf', kind: 'pdf', parser: 'optum-passages', cadence: 'monthly', verified: 'yes' },
  // Premium formulary utilization-management lists by cycle (Jan 1 and Jul 1): step therapy, prior authorization, quantity limits.
  { id: 'optum-premium-um-lists', pbm: 'Optum Rx', owner: 'business.optum.com', name: 'Optum Rx Premium formulary UM lists (ST, PA, QL) by cycle', kind: 'probe', parser: 'none', cadence: 'January and July',
    probe: { templates: ['https://business.optum.com/content/dam/noindex-resources/consumers/pdfs/guides/st-premium-um-drug-list-{MM}{DD}{YY}.pdf', 'https://business.optum.com/content/dam/noindex-resources/consumers/pdfs/guides/pa-premium-um-drug-list-{MM}{DD}{YY}.pdf', 'https://business.optum.com/content/dam/noindex-resources/consumers/pdfs/guides/ql-premium-um-drug-list-{MM}{DD}{YY}.pdf'], dates: 'halves', idPrefix: 'optum-um-', namePrefix: 'Optum Rx Premium UM list ' } },
  // Full Premium Standard formulary, client-hosted copy of Optum's booklet (July 2026 cycle).
  { id: 'optum-premium-standard-formulary-jul-2026', pbm: 'Optum Rx', owner: 'hr.brown.edu (client copy)', name: 'Optum Rx Premium Standard Formulary, July 2026 cycle (client copy)', url: 'https://hr.brown.edu/sites/default/files/health-wellness/prescriptions/July%202026%20B2C%20Cycle%20Premium%20Formulary%20Booklet_Standard_Abridged_508.pdf', kind: 'pdf', parser: 'none', cadence: 'January and July', verified: 'client copy' },
];

module.exports = { SOURCES };
