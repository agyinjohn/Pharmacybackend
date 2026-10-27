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
      const al = norm(a);
      if (al && names.some((n) => n && (n.includes(al) || al.includes(n)))) warnings.push(`ALLERGY: patient is allergic to ${a} (${p.brand})`);
    });
  });
  INTERACTIONS.forEach(([a, b, msg]) => {
    if (gen.some((g) => g.includes(a)) && gen.some((g) => g.includes(b))) warnings.push(`Interaction ${a} + ${b}: ${msg}`);
  });
  return warnings;
};

module.exports = { checkPrescription };
