// sources.js
// Documents the commercial collector watches. Each entry is one URL that is
// re-fetched on every run; when its content changes, the text is re-extracted
// and compared with the previous version.
//
// Fields:
//   id        short unique name, used as the folder under data/docs/
//   pbm       which PBM the document belongs to
//   owner     who hosts it (so a broken link is easy to trace)
//   name      human-readable title for the report
//   url       direct link to the document (pdf, xlsx or html)
//   kind      'pdf' | 'xlsx' | 'html'
//   cadence   when the publisher usually changes it (for the calendar view)
//   verified  'yes' if the URL was confirmed to resolve when added; the first
//             run reports any URL that fails
//
// Add a line for each new document. Keep ids stable once data exists for them.

const SOURCES = [
  // ---- CVS Caremark / Aetna (commercial formularies hosted on MMIT's formularynavigator) ----
  { id: 'aetna-acp-2027', pbm: 'CVS Caremark', owner: 'Aetna via formularynavigator.com', name: '2027 Advanced Control Plan, Aetna', url: 'https://fm.formularynavigator.com/FBO/41/2027_Advanced_Control_Plan_Aetna.pdf', kind: 'pdf', cadence: 'updated the first week of each month (per the document)', verified: 'yes' },
  // 2026 edition at the same address pattern. File name inferred from the 2027 one, not verified; the run log will say if it 404s.
  { id: 'aetna-acp-2026', pbm: 'CVS Caremark', owner: 'Aetna via formularynavigator.com', name: '2026 Advanced Control Plan, Aetna', url: 'https://fm.formularynavigator.com/FBO/41/2026_Advanced_Control_Plan_Aetna.pdf', kind: 'pdf', cadence: 'monthly', verified: 'inferred' },

  // ---- Express Scripts / Evernorth ----
  { id: 'esi-npf-changes-jul-2026', pbm: 'Express Scripts', owner: 'Evernorth', name: 'National Preferred Formulary exclusion changes effective July 1, 2026', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/NPF%207.1.26%20Changes.pdf?version=0', kind: 'pdf', cadence: 'January and July', verified: 'yes' },
  { id: 'esi-npf-changes-jan-2026', pbm: 'Express Scripts', owner: 'Evernorth', name: 'National Preferred Formulary exclusion changes effective January 1, 2026', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/2026%20NPF%20Changes.250806.pdf?version=0', kind: 'pdf', cadence: 'January and July', verified: 'yes' },
  { id: 'esi-npf-flex-changes-jan-2026', pbm: 'Express Scripts', owner: 'Evernorth', name: 'National Preferred Flex Formulary exclusion changes effective January 1, 2026', url: 'https://my.comms.evernorth.com/rs/190-RZO-340/images/2026%20NPF%20Flex%20Changes.250806.pdf?version=0', kind: 'pdf', cadence: 'January and July', verified: 'yes' },

  // ---- Optum Rx ----
  // This index page lists every monthly Pharmacy Passages issue and the formulary/UM update files.
  // The collector reads the links off it on every run and adds any new PDF or XLSX as a source automatically.
  { id: 'optum-formulary-updates-page', pbm: 'Optum Rx', owner: 'business.optum.com', name: 'Optum Rx formulary and UM updates page (Pharmacy Passages index)', url: 'https://business.optum.com/en/support/hcp-resources/formulary-updates.html', kind: 'html', cadence: 'monthly', verified: 'yes',
    discover: { pattern: /passages[^"']*\.pdf|formulary[^"']*updates[^"']*\.(pdf|xlsx)/i, idPrefix: 'optum-', namePrefix: 'Optum Rx: ', pbm: 'Optum Rx', kind: 'pdf', cadence: 'monthly' } },
  { id: 'optum-pharmacy-passages-sep-2025', pbm: 'Optum Rx', owner: 'business.optum.com', name: 'Pharmacy Passages, September 2025 (Jan 2026 cycle)', url: 'https://business.optum.com/content/dam/noindex-resources/consumers/pdfs/forms/PharmacyPassages-September-2025.pdf', kind: 'pdf', cadence: 'monthly', verified: 'yes' },
];

module.exports = { SOURCES };
