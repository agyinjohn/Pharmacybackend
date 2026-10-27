// Small built-in interaction table so the demo works offline. Production would call a drug
// information provider (see requirements section 9).
const INTERACTIONS = [
  ['warfarin', 'ibuprofen', 'Increased bleeding risk'],
  ['warfarin', 'diclofenac', 'Increased bleeding risk'],
  ['tramadol', 'diazepam', 'Additive sedation and respiratory depression'],
  ['morphine', 'diazepam', 'Additive sedation and respiratory depression'],
  ['tramadol', 'morphine', 'Duplicate opioid therapy'],
  ['ibuprofen', 'diclofenac', 'Duplicate NSAID therapy'],
  ['amlodipine', 'simvastatin', 'Raised simvastatin levels'],
  ['metformin', 'alcohol', 'Lactic acidosis risk'],
];

const norm = (s) => String(s || '').toLowerCase();

// Allergies are usually recorded as a drug class ("penicillin", "sulfa"), so expand each class
// to the generic names it covers before matching.
const ALLERGY_CLASSES = {
  penicillin: ['amoxicillin', 'ampicillin', 'flucloxacillin', 'cloxacillin', 'benzylpenicillin', 'phenoxymethylpenicillin', 'piperacillin'],
  cephalosporin: ['cefuroxime', 'ceftriaxone', 'cefalexin', 'cefixime', 'cefpodoxime'],
  sulfa: ['sulfamethoxazole', 'sulfadoxine', 'sulfasalazine'],
  sulphonamide: ['sulfamethoxazole', 'sulfadoxine', 'sulfasalazine'],
  nsaid: ['ibuprofen', 'diclofenac', 'naproxen', 'aspirin', 'piroxicam', 'indomethacin'],
  aspirin: ['aspirin', 'acetylsalicylic acid'],
  opioid: ['morphine', 'tramadol', 'codeine', 'pethidine'],
  macrolide: ['erythromycin', 'azithromycin', 'clarithromycin'],
  quinolone: ['ciprofloxacin', 'levofloxacin', 'ofloxacin'],
};
const allergyTerms = (a) => {
  const al = norm(a).replace(/s$/, '');
  const hit = Object.entries(ALLERGY_CLASSES).find(([k]) => al.includes(k) || k.includes(al));
  return [al, ...(hit ? hit[1] : [])];
};

const checkPrescription = (products, allergies = []) => {
  const warnings = [];
  const gen = products.map((p) => norm(p.generic || p.brand));
  const seen = new Set();
  gen.forEach((g, i) => {
    if (seen.has(g)) warnings.push(`Duplicate therapy: ${products[i].generic || products[i].brand}`);
    seen.add(g);
  });
  products.forEach((p) => {
    const names = [norm(p.generic), norm(p.brand)];
    allergies.forEach((a) => {
      if (!norm(a)) return;
      const terms = allergyTerms(a);
      if (names.some((n) => n && terms.some((t) => n.includes(t) || t.includes(n)))) warnings.push(`ALLERGY: patient is allergic to ${a} (${p.brand})`);
    });
  });
  INTERACTIONS.forEach(([a, b, msg]) => {
    if (gen.some((g) => g.includes(a)) && gen.some((g) => g.includes(b))) warnings.push(`Interaction ${a} + ${b}: ${msg}`);
  });
  return warnings;
};

module.exports = { checkPrescription };
