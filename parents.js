// parents.js
// Maps the CONTRACT_NAME field in the CMS Plan Information file to a parent
// company, its ticker, and the PBM that administers the Part D benefit.
//
// How it works: each entry has a regular expression that is tested against the
// contract name (case-insensitive). The first match wins, so the more specific
// patterns sit above the general ones. Contract names that match nothing are
// tagged parent "UNMAPPED" and listed in the run log and in
// data/partd/unmapped-contracts.csv so the map can be extended after each run.
//
// Accuracy note: parent assignments were written from industry knowledge, not
// checked against filings. Entries with note "verify" have not been confirmed
// against a primary source. The pbm field is the PBM the parent is publicly
// understood to use for its Part D book and is likewise marked where unconfirmed.

const PARENTS = [
  // ---- UnitedHealth Group / Optum Rx ----
  { match: /unitedhealth|united health|\buhc\b|optum|sierra health|rocky mountain health|care improvement plus|preferred care partners|preferred care network|physicians health choice|arizona physicians|oxford health|pacificare|peoples health/i,
    parent: 'UnitedHealth Group', ticker: 'UNH', pbm: 'Optum Rx', note: 'Peoples Health: UHC subsidiary since 2014 (verify)' },

  // ---- CVS Health / Aetna / SilverScript / Caremark ----
  { match: /silverscript|aetna|\bcvs\b|coventry|first health/i,
    parent: 'CVS Health (Aetna / SilverScript)', ticker: 'CVS', pbm: 'CVS Caremark' },

  // ---- Cigna Group / Express Scripts ----
  { match: /cigna|express scripts|evernorth|healthspring|bravo health|loyal american|medco/i,
    parent: 'Cigna Group', ticker: 'CI', pbm: 'Express Scripts', note: 'Medco Containment contracts are the legacy Express Scripts Medicare PDP entity (verify)' },

  // ---- Humana (in-house pharmacy, CenterWell) ----
  { match: /humana|careplus|emphesys|arcadian|cariten|cha hmo|compcare/i,
    parent: 'Humana', ticker: 'HUM', pbm: 'Humana Pharmacy Solutions / CenterWell (in-house)', note: 'Emphesys, Arcadian, Cariten, CHA HMO, CompCare are Humana entities (verify)' },

  // ---- Elevance Health / CarelonRx ----
  { match: /elevance|anthem|wellpoint|carelon|amerigroup|empire healthchoice|blue cross of california|unicare|healthkeepers|community insurance company|matthew thornton|rocky mountain hospital|hmo colorado|freedom health|optimum healthcare|mmm healthcare|healthsun|simply healthcare|mmm of florida/i,
    parent: 'Elevance Health', ticker: 'ELV', pbm: 'CarelonRx', note: 'Freedom, Optimum, MMM, HealthSun acquired 2020 onward (verify)' },

  // ---- Centene / WellCare ----
  { match: /centene|wellcare|wellcare prescription|health net|fidelis|new york quality healthcare|superior healthplan|peach state|sunshine state|sunshine health|buckeye|ambetter|allwell|magnolia|meridian|absolute total care|home state|louisiana healthcare connections|managed health services|silversummit|trillium|western sky|nebraska total care|coordinated care|arkansas total care|iowa total care|pa health|mhs health|harmony health plan|american progressive life|celtic insurance|sunflower state|health & wellness|health and wellness|healthy arkansas|healthy mississippi/i,
    parent: 'Centene', ticker: 'CNC', pbm: 'Express Scripts (contracted; verify)', note: 'WellCare MA and PDP ownership by contract should be verified; American Progressive came with Universal American via WellCare (verify)' },

  // ---- Molina ----
  { match: /molina|senior whole health/i,
    parent: 'Molina Healthcare', ticker: 'MOH', pbm: 'CVS Caremark (contracted; verify)', note: 'Senior Whole Health acquired by Molina 2018 (verify)' },

  // ---- Other public names ----
  { match: /alignment health/i,
    parent: 'Alignment Healthcare', ticker: 'ALHC', pbm: 'verify' },
  { match: /clover/i,
    parent: 'Clover Health', ticker: 'CLOV', pbm: 'verify' },

  // ---- Large privates and nonprofits ----
  { match: /devoted/i,
    parent: 'Devoted Health (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /scan /i,
    parent: 'SCAN Health Plan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /kaiser/i,
    parent: 'Kaiser Permanente (nonprofit)', ticker: 'PRIVATE', pbm: 'In-house' },
  { match: /mutual of omaha/i,
    parent: 'Mutual of Omaha (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /elixir|rite aid/i,
    parent: 'Elixir / Rite Aid (private)', ticker: 'PRIVATE', pbm: 'Elixir' },
  { match: /highmark|keystone health plan central|capital advantage|gateway health/i,
    parent: 'Highmark / Capital Blue (nonprofit Blues)', ticker: 'PRIVATE', pbm: 'Express Scripts (verify)', note: 'Capital Blue Cross and Keystone Central are separate from Highmark; grouped here as PA Blues (verify)' },
  { match: /keystone health plan east|independence blue|qcc insurance/i,
    parent: 'Independence Blue Cross (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /california physicians|blue shield of california/i,
    parent: 'Blue Shield of California (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /triple.?s|guidewell|florida blue|blue cross and blue shield of florida|capital health plan/i,
    parent: 'GuideWell / Florida Blue / Triple-S (private)', ticker: 'PRIVATE', pbm: 'Prime Therapeutics (verify)' },
  { match: /metroplus/i,
    parent: 'MetroPlus / NYC Health + Hospitals (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /amerihealth caritas/i,
    parent: 'AmeriHealth Caritas (IBX and BCBS Michigan JV, private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mass general brigham|commonwealth care alliance|neighborhood health plan|capital district physicians|cox health|st\. luke.?s health plan|baycare|partners insurance|southeastern indiana|community care health plan of louisiana|vns choice|vna homecare|mercy care|hamaspik|village senior|primewest/i,
    parent: 'Provider-sponsored or nonprofit regional plan', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /pruitthealth|provider partners|nhc advantage|signature advantage|procare advantage|liberty advantage|lifeworks advantance|lifeworks advantage|medcare partners|american health plan of|align senior care|simpra|sapphire edge|marquis advantage|eternalhealth|verda health|range health|ks plan administrators|kansas superior select|arkansas superior select|beshp|thp insurance/i,
    parent: 'Institutional SNP or regional MA startup (private, various)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /health insurance plan of greater new york|emblemhealth|\bhip\b/i,
    parent: 'EmblemHealth (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /selecthealth|intermountain/i,
    parent: 'SelectHealth / Intermountain (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mcs advantage|mcs life/i,
    parent: 'MCS (Puerto Rico, private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /alliance health and life|health alliance plan|\bhap\b/i,
    parent: 'Health Alliance Plan / Henry Ford (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /pacificsource/i,
    parent: 'PacificSource (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mount carmel|trinity health/i,
    parent: 'Trinity Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /viva health/i,
    parent: 'VIVA Health / UAB (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /elderplan|mjhs/i,
    parent: 'MJHS Elderplan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /health partners plans|jefferson/i,
    parent: 'Jefferson Health Plans (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /hopkins health/i,
    parent: 'Johns Hopkins (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /community health choice/i,
    parent: 'Community Health Choice / Harris Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /peak health/i,
    parent: 'Peak Health / WVU Medicine (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /health new england|baystate/i,
    parent: 'Health New England / Baystate (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },

  // ---- Regional MA startups and privates (grouped) ----
  { match: /solis health|ultimate health|doctors healthcare|leon health|hpmp of florida|medisun|gold kidney|astiva|champion health|clever care|alterwood|perennial advantage|atrio|globalhealth|care n. care|chinese community|communitycare government|amh health|secur inc|oh chs snp/i,
    parent: 'Regional MA plan (private, various)', ticker: 'PRIVATE', pbm: 'verify' },

  // ---- Catch-all Blues ----
  { match: /blue cross|blue shield|bcbs|bluecross|blueshield|wellmark|premera|regence|cambia|carefirst|horizon|capital blue|excellus|lifetime healthcare|hcsc|health care service corporation|arkansas blue|blue care network|blue plus|hmo louisiana|hmo partners|usable|louisiana health service|volunteer state/i,
    parent: 'Blue Cross Blue Shield affiliate (various)', ticker: 'VARIES', pbm: 'Prime Therapeutics or other (verify per plan)' },

  // ---- Catch-all regional and provider-sponsored ----
  { match: /medica|healthpartners|priority health|geisinger|upmc|ucare|sentara|optima|healthfirst|mvp health|cdphp|independent health|security health|dean health|quartz|essence|aspire health|bright health|moda|providence health|martin.?s point|health alliance|baylor scott|scott and white|avera|sanford|medical mutual|aultcare|paramount|summacare|the health plan|tufts|harvard pilgrim|point32|fallon|wellsense|boston medical|network health|mclaren|zing|caresource|presbyterian|banner|sharp|inland empire|l\.a\. care|central health|brand new day|imperial health|hometown|allina|gundersen|marshfield|hap/i,
    parent: 'Regional or provider-sponsored plan', ticker: 'PRIVATE', pbm: 'verify' },
];

function mapContract(contractName) {
  const name = (contractName || '').trim();
  for (const p of PARENTS) {
    if (p.match.test(name)) {
      return { parent: p.parent, ticker: p.ticker, pbm: p.pbm };
    }
  }
  return { parent: 'UNMAPPED', ticker: '', pbm: '' };
}

module.exports = { PARENTS, mapContract };
