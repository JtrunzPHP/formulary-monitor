// parents.js
// Maps the CONTRACT_NAME field in the CMS Plan Information file to a parent
// company, its ticker, and the PBM that administers the Part D benefit.
//
// How it works: each entry has a regular expression that is tested against the
// contract name (case-insensitive). The first match wins, so put the more
// specific patterns above the general ones. Contract names that match nothing
// are tagged parent "UNMAPPED" and listed in the run log so the map can be
// extended after each run.
//
// The pbm field is the PBM the parent is publicly understood to use for its
// Part D book. Entries marked "verify" have not been checked against a primary
// source yet and should be treated as a working assumption until confirmed.

const PARENTS = [
  // ---- The big three PBM-owned books ----
  { match: /unitedhealth|united health|uhc|optum|sierra health|rocky mountain health|care improvement plus|preferred care partners|physicians health choice|arizona physicians|oxford health|pacificare/i,
    parent: 'UnitedHealth Group', ticker: 'UNH', pbm: 'Optum Rx' },

  { match: /silverscript|aetna|cvs|coventry|first health|wellcare prescription|wellcare health plans/i,
    parent: 'CVS Health (Aetna / SilverScript)', ticker: 'CVS', pbm: 'CVS Caremark', note: 'WellCare PDP contracts transferred to CVS over 2024-2025; verify current ownership per contract' },

  { match: /cigna|express scripts|evernorth|healthspring|bravo health|loyal american/i,
    parent: 'Cigna Group', ticker: 'CI', pbm: 'Express Scripts' },

  // ---- Other managed care parents in coverage ----
  { match: /humana|carecentrix|careplus|humana benefit plan/i,
    parent: 'Humana', ticker: 'HUM', pbm: 'Humana Pharmacy Solutions / CenterWell (in-house)' },

  { match: /elevance|anthem|wellpoint|carelon|amerigroup|empire healthchoice|blue cross of california|anthem blue cross|unicare|healthkeepers|community insurance company|matthew thornton|rocky mountain hospital/i,
    parent: 'Elevance Health', ticker: 'ELV', pbm: 'CarelonRx' },

  { match: /centene|wellcare of|wellcare health insurance|health net|fidelis|superior healthplan|peach state|sunshine health|buckeye|ambetter|allwell|magnolia|meridian|absolute total care|home state|louisiana healthcare connections|managed health services|silversummit|trillium|western sky|nebraska total care|coordinated care|arkansas total care|iowa total care|pa health|mhs health/i,
    parent: 'Centene', ticker: 'CNC', pbm: 'Express Scripts (contracted; verify)' },

  { match: /molina/i,
    parent: 'Molina Healthcare', ticker: 'MOH', pbm: 'CVS Caremark (contracted; verify)' },

  { match: /alignment health/i,
    parent: 'Alignment Healthcare', ticker: 'ALHC', pbm: 'verify' },

  { match: /clover health/i,
    parent: 'Clover Health', ticker: 'CLOV', pbm: 'verify' },

  { match: /devoted health/i,
    parent: 'Devoted Health (private)', ticker: 'PRIVATE', pbm: 'verify' },

  { match: /scan health/i,
    parent: 'SCAN Health Plan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },

  { match: /kaiser/i,
    parent: 'Kaiser Permanente (nonprofit)', ticker: 'PRIVATE', pbm: 'In-house' },

  // ---- Other named carriers worth tagging ----
  { match: /mutual of omaha/i,
    parent: 'Mutual of Omaha (private)', ticker: 'PRIVATE', pbm: 'verify' },

  { match: /elixir|rite aid/i,
    parent: 'Elixir / Rite Aid (private)', ticker: 'PRIVATE', pbm: 'Elixir' },

  { match: /highmark/i,
    parent: 'Highmark (nonprofit)', ticker: 'PRIVATE', pbm: 'Express Scripts (verify)' },

  { match: /blue cross|blue shield|bcbs|bluecross|blueshield|wellmark|premera|regence|cambia|carefirst|horizon|independence blue|capital blue|excellus|lifetime healthcare|triple-s|florida blue|hcsc|health care service corporation|arkansas blue|blue care network|blue plus/i,
    parent: 'Blue Cross Blue Shield affiliate', ticker: 'VARIES', pbm: 'Prime Therapeutics or other (verify per plan)' },

  { match: /medica|healthpartners|priority health|geisinger|upmc|ucare|sentara|optima|emblemhealth|hip health plan|healthfirst|mvp health|cdphp|independent health|security health|dean health|quartz|essence|aspire health|bright health|moda|providence health|peoplesone|cdphp|martin.?s point|health alliance|baylor scott|scott and white|avera|sanford|medical mutual|aultcare|paramount|summacare|the health plan|tufts|harvard pilgrim|point32|fallon|wellsense|boston medical|network health|mclaren|hap|health alliance plan|zing/i,
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
