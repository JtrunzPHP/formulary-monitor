// watchlist.js
// Names to flag wherever they appear: in Part D diff rows and in the text of
// commercial formulary documents. Each entry is a regular expression tested
// against drug names, ingredients, manufacturer names and document text
// (case-insensitive), with the ticker and a short label for the report.
//
// Add a line for anything you want surfaced on its own. Keep patterns specific
// enough not to fire on common words.

const WATCHLIST = [
  // ---- Diabetes devices and supplies ----
  { match: /dexcom|\bg6\b|\bg7\b|\bstelo\b/i, ticker: 'DXCM', label: 'Dexcom CGM' },
  { match: /freestyle libre|libre 2|libre 3|libre rio|lingo|abbott diabetes/i, ticker: 'ABT', label: 'Abbott FreeStyle Libre' },
  { match: /omnipod|insulet/i, ticker: 'PODD', label: 'Insulet Omnipod' },
  { match: /tandem|t:slim|mobi\b/i, ticker: 'TNDM', label: 'Tandem pump' },
  { match: /medtronic|minimed|guardian sensor|simplera/i, ticker: 'MDT', label: 'Medtronic diabetes' },
  { match: /onetouch|one touch|lifescan/i, ticker: 'PRIVATE', label: 'LifeScan OneTouch (private)' },
  { match: /accu-chek|accu chek/i, ticker: 'ROG SW', label: 'Roche Accu-Chek' },
  { match: /contour next|ascensia/i, ticker: 'PRIVATE', label: 'Ascensia Contour (PHC Holdings)' },
  { match: /glucose monitor|cgm\b|continuous glucose|test strip|glucose meter|lancet|diabetic suppl/i, ticker: '', label: 'Diabetic supplies (category)' },

  // ---- GLP-1 and obesity ----
  { match: /semaglutide|ozempic|wegovy|rybelsus/i, ticker: 'NVO', label: 'Novo semaglutide' },
  { match: /tirzepatide|mounjaro|zepbound/i, ticker: 'LLY', label: 'Lilly tirzepatide' },
  { match: /orforglipron/i, ticker: 'LLY', label: 'Lilly orforglipron' },
  { match: /liraglutide|victoza|saxenda/i, ticker: 'NVO', label: 'Novo liraglutide' },
  { match: /dulaglutide|trulicity/i, ticker: 'LLY', label: 'Lilly dulaglutide' },

  // ---- Insulin ----
  { match: /insulin|lantus|toujeo|basaglar|semglee|rezvoglar|humalog|novolog|admelog|lyumjev|fiasp|tresiba|levemir|humulin|novolin/i, ticker: '', label: 'Insulin (category)' },

  // ---- Specialty and infusion names in coverage ----
  { match: /option care/i, ticker: 'OPCH', label: 'Option Care' },
  { match: /brightspring|onco360|pharmerica/i, ticker: 'BTSG', label: 'BrightSpring' },
  { match: /guardian pharmacy/i, ticker: 'GRDN', label: 'Guardian Pharmacy' },

  // ---- Respiratory and sleep devices sometimes listed under pharmacy benefit ----
  { match: /resmed/i, ticker: 'RMD', label: 'ResMed' },
  { match: /respironics|philips/i, ticker: 'PHG', label: 'Philips Respironics' },
];

function watchHits(text) {
  const out = [];
  const s = String(text || '');
  for (const w of WATCHLIST) if (w.match.test(s)) out.push({ ticker: w.ticker, label: w.label });
  return out;
}

module.exports = { WATCHLIST, watchHits };
