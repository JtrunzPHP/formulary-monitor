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
  { match: /silverscript|aetna|\bcvs\b|coventry|\bfirst health\b/i,
    parent: 'CVS Health (Aetna / SilverScript)', ticker: 'CVS', pbm: 'CVS Caremark' },

  // ---- Cigna Group / Express Scripts ----
  // Cigna's Medicare Advantage and Part D business was sold to Health Care Service Corporation (closed 2025);
  // CMS now lists these contracts under HCSC. Kept here as a fallback only; the CMS parent map below takes precedence.
  { match: /cigna|express scripts|evernorth|healthspring|bravo health|loyal american|medco/i,
    parent: 'Health Care Service Corporation (incl. legacy Cigna Medicare)', ticker: 'PRIVATE', pbm: 'verify (Prime Therapeutics for legacy HCSC; Express Scripts transition for legacy Cigna)', note: 'verify against CMS parent field' },

  // ---- Humana (in-house pharmacy, CenterWell) ----
  { match: /humana|careplus|emphesys|arcadian|cariten|cha hmo/i,
    parent: 'Humana', ticker: 'HUM', pbm: 'Humana Pharmacy Solutions / CenterWell (in-house)', note: 'Emphesys, Arcadian, Cariten, CHA HMO are Humana entities (verify)' },

  // ---- Elevance Health / CarelonRx ----
  { match: /elevance|anthem|wellpoint|carelon|amerigroup|empire healthchoice|blue cross of california|unicare|healthkeepers|community insurance company|matthew thornton|rocky mountain hospital|hmo colorado|freedom health|optimum healthcare|mmm healthcare|healthsun|simply healthcare|mmm of florida|compcare/i,
    parent: 'Elevance Health', ticker: 'ELV', pbm: 'CarelonRx', note: 'Freedom, Optimum, MMM, HealthSun acquired 2020 onward (verify)' },

  // ---- Centene / WellCare ----
  { match: /centene|wellcare|wellcare prescription|health net|fidelis|new york quality healthcare|superior healthplan|peach state|sunshine state|sunshine health|buckeye|ambetter|allwell|magnolia|meridian|absolute total care|home state|louisiana healthcare connections|managed health services|silversummit|trillium|western sky|nebraska total care|coordinated care|arkansas total care|iowa total care|pa health|mhs health|harmony health plan|american progressive life|celtic insurance|sunflower state|health & wellness|health and wellness|healthy arkansas|bridgeway health|missouri care/i,
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
  { match: /keystone health plan central|capital advantage|capital blue/i,
    parent: 'Capital Blue Cross (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /highmark|gateway health/i,
    parent: 'Highmark Health (nonprofit)', ticker: 'PRIVATE', pbm: 'Express Scripts (verify)' },
  { match: /keystone health plan east|independence blue|qcc insurance/i,
    parent: 'Independence Blue Cross (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /california physicians|blue shield of california/i,
    parent: 'Blue Shield of California (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /health care service corporation|\bhcsc\b/i,
    parent: 'Health Care Service Corporation (incl. legacy Cigna Medicare)', ticker: 'PRIVATE', pbm: 'verify (Prime Therapeutics for legacy HCSC; Express Scripts transition for legacy Cigna)' },
  { match: /triple.?s|guidewell|florida blue|blue cross and blue shield of florida|capital health plan/i,
    parent: 'GuideWell / Florida Blue (private)', ticker: 'PRIVATE', pbm: 'Prime Therapeutics (verify)' },
  { match: /metroplus/i,
    parent: 'MetroPlus / NYC Health + Hospitals (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /amerihealth/i,
    parent: 'AmeriHealth Caritas (IBX and BCBS Michigan JV, private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mass general brigham|commonwealth care alliance|neighborhood health plan|capital district physicians|cox health|st\. luke.?s health plan|baycare|partners insurance|southeastern indiana|community care health plan of louisiana|vns choice|vna homecare|mercy care|hamaspik|village senior|primewest/i,
    parent: 'Provider-sponsored or nonprofit regional plan', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /pruitthealth|provider partners|nhc advantage|signature advantage|procare advantage|liberty advantage|lifeworks advantance|lifeworks advantage|medcare partners|american health plan of|align senior care|simpra|sapphire edge|marquis advantage|eternalhealth|verda health|range health|ks plan administrators|kansas superior select|arkansas superior select|beshp|thp insurance/i,
    parent: 'Institutional SNP or regional MA startup (private, various)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /health insurance plan of greater new york|emblemhealth|\bhip\b/i,
    parent: 'EmblemHealth (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /selecthealth|intermountain/i,
    parent: 'Intermountain / SelectHealth (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mcs advantage|mcs life/i,
    parent: 'MCS / MHH Healthcare (Puerto Rico, private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /alliance health and life|health alliance plan|\bhap\b/i,
    parent: 'Health Alliance Plan / Henry Ford (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /pacificsource/i,
    parent: 'PacificSource (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mount carmel|trinity health/i,
    parent: 'Trinity Health Corporation (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /viva health/i,
    parent: 'VIVA Health / UAB (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /elderplan|mjhs/i,
    parent: 'MJHS Elderplan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /health partners plans|jefferson/i,
    parent: 'Jefferson Health Plans (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /hopkins health/i,
    parent: 'Johns Hopkins Medicine (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /community health choice/i,
    parent: 'Harris Health / Community Health Choice (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /peak health/i,
    parent: 'WVU Medicine / Peak Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /health new england|baystate/i,
    parent: 'Baystate Health / Health New England (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },

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


// ---------------------------------------------------------------------------
// CMS "Parent Organization" map. This is the authoritative ownership field in
// CMS's Monthly Enrollment by Plan file and takes precedence over the
// contract-name patterns above whenever a plan has an enrollment row.
// First match wins. Names not matched fall back to the contract-name map.
// ---------------------------------------------------------------------------
const CMS_PARENTS = [
  { match: /unitedhealth/i, parent: 'UnitedHealth Group', ticker: 'UNH', pbm: 'Optum Rx' },
  { match: /^humana/i, parent: 'Humana', ticker: 'HUM', pbm: 'Humana Pharmacy Solutions / CenterWell (in-house)' },
  { match: /^centene/i, parent: 'Centene', ticker: 'CNC', pbm: 'Express Scripts (contracted; verify)' },
  { match: /^cvs health/i, parent: 'CVS Health (Aetna / SilverScript)', ticker: 'CVS', pbm: 'CVS Caremark' },
  { match: /health care service corporation|^hcsc/i, parent: 'Health Care Service Corporation (incl. legacy Cigna Medicare)', ticker: 'PRIVATE', pbm: 'verify (Prime Therapeutics for legacy HCSC; Express Scripts transition for legacy Cigna)' },
  { match: /^elevance/i, parent: 'Elevance Health', ticker: 'ELV', pbm: 'CarelonRx' },
  { match: /^kaiser/i, parent: 'Kaiser Permanente (nonprofit)', ticker: 'PRIVATE', pbm: 'In-house' },
  { match: /^molina/i, parent: 'Molina Healthcare', ticker: 'MOH', pbm: 'CVS Caremark (contracted; verify)' },
  { match: /^cigna/i, parent: 'Cigna Group', ticker: 'CI', pbm: 'Express Scripts' },
  { match: /^alignment/i, parent: 'Alignment Healthcare', ticker: 'ALHC', pbm: 'verify' },
  { match: /^clover/i, parent: 'Clover Health', ticker: 'CLOV', pbm: 'verify' },
  { match: /^devoted/i, parent: 'Devoted Health (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^scan/i, parent: 'SCAN Health Plan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^highmark/i, parent: 'Highmark Health (nonprofit)', ticker: 'PRIVATE', pbm: 'Express Scripts (verify)' },
  { match: /capital blue cross/i, parent: 'Capital Blue Cross (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /bluecross blueshield association/i, parent: 'BCBS Association FEP (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^mhh healthcare/i, parent: 'MCS / MHH Healthcare (Puerto Rico, private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^healthfirst/i, parent: 'Healthfirst (nonprofit, NY)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^medica holding/i, parent: 'Medica (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^aware integrated/i, parent: 'Blue Cross Blue Shield of Minnesota (Aware Integrated, nonprofit)', ticker: 'PRIVATE', pbm: 'Prime Therapeutics (verify)' },
  { match: /^lifetime healthcare/i, parent: 'Excellus BCBS (Lifetime Healthcare, nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^guidewell/i, parent: 'GuideWell / Florida Blue (private)', ticker: 'PRIVATE', pbm: 'Prime Therapeutics (verify)' },
  { match: /^corewell/i, parent: 'Corewell Health / Priority Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^upmc/i, parent: 'UPMC Health Plan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /bluecross blueshield of tennessee/i, parent: 'BCBS Tennessee (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /blue cross blue shield of michigan/i, parent: 'BCBS Michigan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^curacor/i, parent: 'CuraCor Solutions (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^caresource/i, parent: 'CareSource (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^independence health/i, parent: 'Independence Blue Cross (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /california physicians/i, parent: 'Blue Shield of California (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /triton health|viva/i, parent: 'VIVA Health / UAB (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /visiting nurse service/i, parent: 'VNS Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /allina health and aetna/i, parent: 'Allina Health | Aetna JV', ticker: 'CVS', pbm: 'CVS Caremark (verify)' },
  { match: /health first shared services/i, parent: 'Health First (Florida, nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /west virginia united health/i, parent: 'WVU Medicine / Peak Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /intermountain/i, parent: 'Intermountain / SelectHealth (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /local initiative health authority|l\.a\. care/i, parent: 'L.A. Care (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^elderplan/i, parent: 'MJHS Elderplan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /baycare/i, parent: 'BayCare (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /orange county health authority|caloptima/i, parent: 'CalOptima (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /new york city health and hospitals/i, parent: 'NYC Health + Hospitals / MetroPlus (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /careoregon/i, parent: 'CareOregon (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /health plan of west virginia/i, parent: 'The Health Plan of West Virginia (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /santa clara county health/i, parent: 'Santa Clara Family Health Plan (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /regents of the university of california/i, parent: 'University of California (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /neighborhood health plan of rhode island/i, parent: 'Neighborhood Health Plan of RI (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^mercy care/i, parent: 'Mercy Care (nonprofit, AZ)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /village care/i, parent: 'VillageCare (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /siho/i, parent: 'SIHO (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /community health group/i, parent: 'Community Health Group (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /rifkin/i, parent: 'Rifkin Managed Care (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /eternal health/i, parent: 'eternalHealth (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /community health plan of washington/i, parent: 'Community Health Plan of Washington (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mutual of omaha/i, parent: 'Mutual of Omaha (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /universal health services/i, parent: 'Universal Health Services (Prominence Health)', ticker: 'UHS', pbm: 'verify' },
  { match: /brightspring/i, parent: 'BrightSpring Health Services (Signature Advantage I-SNP)', ticker: 'BTSG', pbm: 'verify' },
  { match: /risant/i, parent: 'Kaiser Permanente (Risant Health / Geisinger, nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^curacor/i, parent: 'Blue Cross NC (CuraCor Solutions, nonprofit)', ticker: 'PRIVATE', pbm: 'Prime Therapeutics (verify)' },
  { match: /gemstone holdings/i, parent: 'Blue Cross of Idaho (Gemstone, nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /henry ford/i, parent: 'Henry Ford Health / HAP (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /point32/i, parent: 'Point32Health / Tufts (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /zing health/i, parent: 'Zing Health (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /athena healthcare/i, parent: 'Solis Health Plans / Athena Healthcare (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /ultimate healthcare/i, parent: 'Ultimate Health Plans (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mitchell family office/i, parent: 'American Health Plan / Mitchell Family Office (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /trinity health/i, parent: 'Trinity Health Corporation (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /medical mutual of ohio/i, parent: 'Medical Mutual of Ohio (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /lumeris/i, parent: 'Lumeris / Essence Healthcare (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /cambia/i, parent: 'Cambia / Regence (nonprofit)', ticker: 'PRIVATE', pbm: 'Prime Therapeutics (verify)' },
  { match: /champion health/i, parent: 'Champion Health Plans (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /louisiana health service/i, parent: 'Blue Cross Blue Shield of Louisiana (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^atrio/i, parent: 'ATRIO Health Plans (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /gold kidney/i, parent: 'Gold Kidney Health Plan (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /perennial consortium/i, parent: 'Perennial Advantage (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /longevity health/i, parent: 'Longevity Health Plan (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /sanford health/i, parent: 'Sanford Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /thomas jefferson/i, parent: 'Jefferson Health Plans (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /curana/i, parent: 'Curana Health (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /fallon community/i, parent: 'Fallon Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /baylor scott/i, parent: 'Baylor Scott & White (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /network health/i, parent: 'Network Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /astiva/i, parent: 'Astiva Health (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /verda/i, parent: 'Verda Healthcare (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /lifebridge/i, parent: 'LifeBridge Health / Alterwood (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /johns hopkins/i, parent: 'Johns Hopkins Medicine (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /unico services/i, parent: 'PruittHealth Premier / UNICO (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /^mvp health/i, parent: 'MVP Health Care (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /emblemhealth/i, parent: 'EmblemHealth (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /independent health/i, parent: 'Independent Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /general catalyst/i, parent: 'SummaCare / General Catalyst (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /independent living systems/i, parent: 'Independent Living Systems (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /chinese hospital/i, parent: 'Chinese Community Health Plan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /baystate/i, parent: 'Baystate Health / Health New England (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /st francis health|st john health/i, parent: 'CommunityCare Oklahoma (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /lmc family/i, parent: 'Leon Health (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /usable mutual/i, parent: 'Arkansas Blue Cross (USAble, nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /clever care/i, parent: 'Clever Care Health Plan (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /montage health/i, parent: 'Montage Health / Aspire (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mass general brigham/i, parent: 'Mass General Brigham (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /marquis companies/i, parent: 'Marquis Advantage (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /healthpartners/i, parent: 'HealthPartners (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /coxhealth/i, parent: 'CoxHealth (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /chapters carenu/i, parent: 'Chapters Health / CareNu (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /presbyterian healthcare/i, parent: 'Presbyterian Health Plan (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /el paso county hospital/i, parent: 'El Paso First (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /first sacramento/i, parent: 'ProCare Advantage (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /aultman/i, parent: 'AultCare (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /snp holdings|isnp holdings|regency isnp/i, parent: 'Institutional SNP operator (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /hawaii medical service/i, parent: 'HMSA (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /pacificsource/i, parent: 'PacificSource (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /associated care ventures/i, parent: 'Simpra Advantage (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /banner health/i, parent: 'Banner Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /mclaren/i, parent: 'McLaren Health Care (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /liberty healthcare/i, parent: 'Liberty Advantage (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /carefirst/i, parent: 'CareFirst BCBS (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /horizon mutual/i, parent: 'Horizon BCBS NJ (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /visiting nurse association of central/i, parent: 'VNA Homecare (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /hamaspik/i, parent: 'Hamaspik (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /select founders|kansas superior select|oklahoma superior select/i, parent: 'Superior Select (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /primewest|south country|itasca county/i, parent: 'Minnesota county-based purchasing (public)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /sentara/i, parent: 'Sentara Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /doctors healthcare plans/i, parent: 'Doctors HealthCare Plans (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /missouri healthcare advisors/i, parent: 'NHC Advantage (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /troy holdings/i, parent: 'Troy Health (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /bexar county|harris county|denver health|alameda alliance|kern health|contra costa|santa cruz|san joaquin|santa barbara|san francisco health|inland empire|imperial county|ventura county|health plan of san mateo|local initiative/i, parent: 'County or public health plan', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /imperial health plan/i, parent: 'Imperial Health Plan (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /martin.?s point/i, parent: "Martin's Point (nonprofit)", ticker: 'PRIVATE', pbm: 'verify' },
  { match: /elite health/i, parent: 'Elite Health Plan (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /group health cooperative/i, parent: 'Group Health Cooperative (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /schroer group/i, parent: 'TSG Guard / Schroer (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /dlp marquette/i, parent: 'Upper Peninsula Health Plan (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /allcare health/i, parent: 'AllCare Health (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /samaritan health/i, parent: 'Samaritan Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /aids healthcare/i, parent: 'AIDS Healthcare Foundation (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /alohacare/i, parent: 'AlohaCare (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /singh holdings/i, parent: 'Healthy Mississippi / Singh Holdings (private)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /university of wisconsin/i, parent: 'Quartz / UW Health (nonprofit)', ticker: 'PRIVATE', pbm: 'verify' },
  { match: /blue cross|blue shield|bcbs|bluecross/i, parent: 'Blue Cross Blue Shield affiliate (various)', ticker: 'VARIES', pbm: 'Prime Therapeutics or other (verify per plan)' },
];

function mapCmsParent(cmsParentName) {
  const name = (cmsParentName || '').trim();
  if (!name) return null;
  for (const p of CMS_PARENTS) if (p.match.test(name)) return { parent: p.parent, ticker: p.ticker, pbm: p.pbm, cms_parent: name };
  // Unknown CMS parent: use CMS's own name so it is never UNMAPPED when CMS knows the owner.
  return { parent: `${name} (per CMS, unmapped ticker)`, ticker: '', pbm: '', cms_parent: name };
}

function mapContract(contractName) {
  const name = (contractName || '').trim();
  for (const p of PARENTS) {
    if (p.match.test(name)) {
      return { parent: p.parent, ticker: p.ticker, pbm: p.pbm };
    }
  }
  return { parent: 'UNMAPPED', ticker: '', pbm: '' };
}

module.exports = { PARENTS, CMS_PARENTS, mapContract, mapCmsParent };
