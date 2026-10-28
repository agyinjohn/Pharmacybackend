// Demo data: a three-branch pharmacy group with stock, staff, prescriptions and online orders.
// WARNING: drops the target database first.   Usage: npm run seed
const mongoose = require('mongoose');
const config = require('./config');
const M = require('./models');
const { addBatch, registerEntry } = require('./services/stock');
const { round2 } = require('./utils/http');

const PASSWORD = 'Demo@1234';
const day = (n) => new Date(Date.now() + n * 86400000);
const rnd = (a, b) => Math.floor(a + Math.random() * (b - a + 1));
const pick = (arr) => arr[rnd(0, arr.length - 1)];

// Demo directions in the style of a standard adult pack label, for showing the feature only. A real
// pharmacy's pharmacist reviews and writes these for their own products. Prescription-only medicines are
// left blank on purpose: their directions come from the prescriber on each prescription.
const DIRECTIONS = {
  'Panadol Extra': ['Adults and children 12 and over: 2 tablets every 4 to 6 hours when needed. No more than 8 tablets in 24 hours.', 'Do not take with any other medicine that contains paracetamol.'],
  'Paracetamol Generic': ['Adults and children 12 and over: 2 tablets every 4 to 6 hours when needed. No more than 8 tablets in 24 hours.', 'Do not take with any other medicine that contains paracetamol.'],
  'Ibuprofen 400': ['Adults: 1 tablet up to 3 times a day, with or after food. Leave at least 6 hours between doses.', 'Take with food. Ask the pharmacist first if you have stomach ulcers, asthma, kidney problems or are pregnant.'],
  'Diclofenac Gel': ['Rub a small amount gently into the painful area 3 to 4 times a day.', 'Do not use on broken skin. Wash your hands after use.'],
  'Coartem 80/480': ['Adults: 1 tablet to start, 1 more after 8 hours, then 1 tablet twice a day for the next 2 days (6 tablets in total).', 'Take with food or milk. Finish the full course even if you feel better.'],
  'Lonart DS': ['Adults: 1 tablet to start, 1 more after 8 hours, then 1 tablet twice a day for the next 2 days (6 tablets in total).', 'Take with food or milk. Finish the full course even if you feel better.'],
  'ORS Sachets': ['Dissolve 1 sachet in the amount of clean drinking water shown on the pack. Sip slowly, especially after each loose stool.', 'See a health worker if diarrhoea lasts more than 2 days, there is blood in the stool, or for babies.'],
  'Loperamide': ['Adults: 2 capsules to start, then 1 after each loose stool. No more than 6 capsules in 24 hours.', 'Not for children under 12. Drink plenty of fluids. Stop and see a doctor if there is fever or blood in the stool.'],
  'Omeprazole 20': ['Adults: 1 capsule once a day before breakfast, for up to 14 days.', 'See a doctor if symptoms continue after 14 days.'],
  'Gaviscon': ['Adults: 10 to 20 ml after meals and at bedtime, up to 4 times a day.', ''],
  'Cetirizine 10': ['Adults and children 12 and over: 1 tablet once a day.', 'May cause drowsiness. Avoid alcohol.'],
  'Benylin Cough Syrup': ['Adults: 10 ml up to 4 times a day.', 'May cause drowsiness. Do not drive if affected.'],
  'Strepsils Lozenges': ['Adults and children 6 and over: dissolve 1 lozenge slowly in the mouth every 2 to 3 hours. No more than 12 in 24 hours.', ''],
  'Vitamin C 1000': ['Adults: dissolve 1 tablet in a glass of water once a day.', ''],
  'Multivitamin Daily': ['Adults: 1 tablet a day with food.', ''],
  'Ferrous Sulphate': ['Adults: 1 tablet once or twice a day, or as your health worker advises.', 'May turn stools dark. Take with food if it upsets your stomach.'],
};

// [brand, generic, strength, form, pack, category, legal, price, cost, tax, symptoms, barcode, extra]
// imageUrl: stable public image for demo catalogue (Wikimedia Commons / Open Food Facts CDN)
const IMAGES = {
  'Panadol Extra':        'https://upload.wikimedia.org/wikipedia/commons/thumb/a/a4/Panadol_Extra_Tablets_UK.jpg/320px-Panadol_Extra_Tablets_UK.jpg',
  'Paracetamol Generic':  'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Ibuprofen 400':        'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Ibuprofen-tablets.jpg/320px-Ibuprofen-tablets.jpg',
  'Diclofenac Gel':       'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Voltaren_Emulgel_100g.jpg/320px-Voltaren_Emulgel_100g.jpg',
  'Diclofenac 50':        'https://upload.wikimedia.org/wikipedia/commons/thumb/3/3e/Voltaren_Emulgel_100g.jpg/320px-Voltaren_Emulgel_100g.jpg',
  'Amoxil':               'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Amoxicillin_Capsules.jpg/320px-Amoxicillin_Capsules.jpg',
  'Amoxicillin Generic':  'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Amoxicillin_Capsules.jpg/320px-Amoxicillin_Capsules.jpg',
  'Augmentin 625':        'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Amoxicillin_Capsules.jpg/320px-Amoxicillin_Capsules.jpg',
  'Ciprofloxacin 500':    'https://upload.wikimedia.org/wikipedia/commons/thumb/c/c5/Ciprofloxacin_500mg_Tablets.jpg/320px-Ciprofloxacin_500mg_Tablets.jpg',
  'Metronidazole 400':    'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Coartem 80/480':       'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/Coartem.jpg/320px-Coartem.jpg',
  'Lonart DS':            'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/Coartem.jpg/320px-Coartem.jpg',
  'Malarone':             'https://upload.wikimedia.org/wikipedia/commons/thumb/2/2e/Coartem.jpg/320px-Coartem.jpg',
  'ORS Sachets':          'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b5/Oral_Rehydration_Salts_%28ORS%29_Packet.jpg/320px-Oral_Rehydration_Salts_%28ORS%29_Packet.jpg',
  'Loperamide':           'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8c/Ibuprofen-tablets.jpg/320px-Ibuprofen-tablets.jpg',
  'Omeprazole 20':        'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Amoxicillin_Capsules.jpg/320px-Amoxicillin_Capsules.jpg',
  'Gaviscon':             'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Gaviscon_Advance_Liquid.jpg/320px-Gaviscon_Advance_Liquid.jpg',
  'Metformin 500':        'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Glibenclamide 5':      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Amlodipine 5':         'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Lisinopril 10':        'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Atorvastatin 20':      'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Cetirizine 10':        'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Benylin Cough Syrup':  'https://upload.wikimedia.org/wikipedia/commons/thumb/9/9e/Gaviscon_Advance_Liquid.jpg/320px-Gaviscon_Advance_Liquid.jpg',
  'Strepsils Lozenges':   'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Vitamin C 1000':       'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Multivitamin Daily':   'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Folic Acid 5mg':       'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Ferrous Sulphate':     'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Salbutamol Inhaler':   'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4e/Salbutamol_Inhaler.jpg/320px-Salbutamol_Inhaler.jpg',
  'Insulin Mixtard 30':   'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/Insulin_Pen.jpg/320px-Insulin_Pen.jpg',
  'Diazepam 5':           'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Tramadol 50':          'https://upload.wikimedia.org/wikipedia/commons/thumb/0/0b/Amoxicillin_Capsules.jpg/320px-Amoxicillin_Capsules.jpg',
  'Morphine Sulphate 10': 'https://upload.wikimedia.org/wikipedia/commons/thumb/8/8b/Paracetamol-tablets.jpg/320px-Paracetamol-tablets.jpg',
  'Nivea Body Lotion':    'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/NIVEA_Creme_tin.jpg/320px-NIVEA_Creme_tin.jpg',
  'Sunscreen SPF50':      'https://upload.wikimedia.org/wikipedia/commons/thumb/4/4b/NIVEA_Creme_tin.jpg/320px-NIVEA_Creme_tin.jpg',
  'Baby Diapers M':       'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b5/Oral_Rehydration_Salts_%28ORS%29_Packet.jpg/320px-Oral_Rehydration_Salts_%28ORS%29_Packet.jpg',
  'Digital Thermometer':  'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6a/Clinical_thermometer_38.7.jpg/320px-Clinical_thermometer_38.7.jpg',
  'BP Monitor Arm':       'https://upload.wikimedia.org/wikipedia/commons/thumb/b/b6/Sphygmomanometer_aneroid.jpg/320px-Sphygmomanometer_aneroid.jpg',
  'Glucometer Strips':    'https://upload.wikimedia.org/wikipedia/commons/thumb/6/6b/Insulin_Pen.jpg/320px-Insulin_Pen.jpg',
};

const CATALOGUE = [
  ['Panadol Extra', 'Paracetamol', '500mg', 'Tablet', '24s', 'Pain & Fever', 'otc', 18, 11, 0, ['Headache', 'Fever', 'Pain']],
  ['Paracetamol Generic', 'Paracetamol', '500mg', 'Tablet', '100s', 'Pain & Fever', 'otc', 12, 6, 0, ['Headache', 'Fever', 'Pain']],
  ['Ibuprofen 400', 'Ibuprofen', '400mg', 'Tablet', '30s', 'Pain & Fever', 'pharmacy_only', 22, 13, 0, ['Pain', 'Fever']],
  ['Diclofenac Gel', 'Diclofenac', '1%', 'Gel', '50g', 'Pain & Fever', 'pharmacy_only', 35, 21, 0, ['Pain']],
  ['Diclofenac 50', 'Diclofenac', '50mg', 'Tablet', '30s', 'Pain & Fever', 'prescription_only', 24, 14, 0, ['Pain']],
  ['Amoxil', 'Amoxicillin', '500mg', 'Capsule', '21s', 'Antibiotics', 'prescription_only', 45, 28, 0, ['Infection']],
  ['Amoxicillin Generic', 'Amoxicillin', '500mg', 'Capsule', '21s', 'Antibiotics', 'prescription_only', 32, 18, 0, ['Infection']],
  ['Augmentin 625', 'Amoxicillin/Clavulanate', '625mg', 'Tablet', '14s', 'Antibiotics', 'prescription_only', 98, 66, 0, ['Infection']],
  ['Ciprofloxacin 500', 'Ciprofloxacin', '500mg', 'Tablet', '10s', 'Antibiotics', 'prescription_only', 40, 24, 0, ['Infection']],
  ['Metronidazole 400', 'Metronidazole', '400mg', 'Tablet', '21s', 'Antibiotics', 'prescription_only', 20, 11, 0, ['Infection', 'Stomach']],
  ['Coartem 80/480', 'Artemether/Lumefantrine', '80/480mg', 'Tablet', '6s', 'Antimalarials', 'pharmacy_only', 55, 34, 0, ['Malaria', 'Fever']],
  ['Lonart DS', 'Artemether/Lumefantrine', '80/480mg', 'Tablet', '6s', 'Antimalarials', 'pharmacy_only', 42, 26, 0, ['Malaria', 'Fever']],
  ['Malarone', 'Atovaquone/Proguanil', '250/100mg', 'Tablet', '12s', 'Antimalarials', 'prescription_only', 180, 130, 0, ['Malaria']],
  ['ORS Sachets', 'Oral Rehydration Salts', '20.5g', 'Powder', '10s', 'Stomach & Digestion', 'otc', 15, 8, 0, ['Diarrhoea', 'Stomach']],
  ['Loperamide', 'Loperamide', '2mg', 'Capsule', '12s', 'Stomach & Digestion', 'pharmacy_only', 14, 8, 0, ['Diarrhoea', 'Stomach']],
  ['Omeprazole 20', 'Omeprazole', '20mg', 'Capsule', '14s', 'Stomach & Digestion', 'pharmacy_only', 28, 15, 0, ['Stomach', 'Heartburn']],
  ['Gaviscon', 'Sodium alginate', '150ml', 'Syrup', '150ml', 'Stomach & Digestion', 'otc', 48, 31, 0, ['Heartburn', 'Stomach']],
  ['Metformin 500', 'Metformin', '500mg', 'Tablet', '60s', 'Diabetes', 'prescription_only', 25, 13, 0, ['Diabetes']],
  ['Glibenclamide 5', 'Glibenclamide', '5mg', 'Tablet', '30s', 'Diabetes', 'prescription_only', 16, 8, 0, ['Diabetes']],
  ['Amlodipine 5', 'Amlodipine', '5mg', 'Tablet', '30s', 'Blood Pressure', 'prescription_only', 22, 11, 0, ['Hypertension']],
  ['Lisinopril 10', 'Lisinopril', '10mg', 'Tablet', '28s', 'Blood Pressure', 'prescription_only', 30, 16, 0, ['Hypertension']],
  ['Atorvastatin 20', 'Atorvastatin', '20mg', 'Tablet', '30s', 'Heart & Cholesterol', 'prescription_only', 58, 34, 0, ['Cholesterol']],
  ['Cetirizine 10', 'Cetirizine', '10mg', 'Tablet', '10s', 'Allergy & Cold', 'otc', 12, 6, 0, ['Allergy', 'Cold', 'Cough']],
  ['Benylin Cough Syrup', 'Dextromethorphan', '100ml', 'Syrup', '100ml', 'Allergy & Cold', 'otc', 38, 24, 0, ['Cough', 'Cold']],
  ['Strepsils Lozenges', 'Amylmetacresol', '24s', 'Lozenge', '24s', 'Allergy & Cold', 'otc', 30, 19, 0, ['Sore throat', 'Cough']],
  ['Vitamin C 1000', 'Ascorbic acid', '1000mg', 'Effervescent', '20s', 'Vitamins', 'otc', 35, 20, 0, ['Immunity']],
  ['Multivitamin Daily', 'Multivitamin', '', 'Tablet', '30s', 'Vitamins', 'otc', 40, 24, 0, ['Immunity']],
  ['Folic Acid 5mg', 'Folic acid', '5mg', 'Tablet', '28s', 'Vitamins', 'otc', 9, 4, 0, ['Pregnancy']],
  ['Ferrous Sulphate', 'Ferrous sulfate', '200mg', 'Tablet', '30s', 'Vitamins', 'otc', 10, 5, 0, ['Anaemia']],
  ['Salbutamol Inhaler', 'Salbutamol', '100mcg', 'Inhaler', '200 dose', 'Respiratory', 'prescription_only', 38, 22, 0, ['Asthma']],
  ['Insulin Mixtard 30', 'Insulin human', '100IU/ml', 'Injection', '10ml', 'Diabetes', 'prescription_only', 120, 85, 0, ['Diabetes'], '', { storage: 'cold_chain' }],
  ['Diazepam 5', 'Diazepam', '5mg', 'Tablet', '28s', 'Controlled', 'controlled', 30, 17, 0, ['Anxiety']],
  ['Tramadol 50', 'Tramadol', '50mg', 'Capsule', '20s', 'Controlled', 'controlled', 38, 22, 0, ['Pain']],
  ['Morphine Sulphate 10', 'Morphine', '10mg', 'Tablet', '28s', 'Controlled', 'controlled', 90, 60, 0, ['Pain'], '', { controlClass: 'strict' }],
  ['Nivea Body Lotion', 'Cosmetic', '400ml', 'Lotion', '400ml', 'Cosmetics', 'otc', 62, 40, 0.15, [], '', { isDrug: false }],
  ['Sunscreen SPF50', 'Cosmetic', '100ml', 'Cream', '100ml', 'Cosmetics', 'otc', 95, 60, 0.15, [], '', { isDrug: false }],
  ['Baby Diapers M', 'Diapers', 'Size M', 'Pack', '40s', 'Baby Care', 'otc', 110, 80, 0.15, [], '', { isDrug: false }],
  ['Digital Thermometer', 'Device', '', 'Device', '1', 'Devices', 'otc', 45, 28, 0.15, ['Fever'], '', { isDrug: false }],
  ['BP Monitor Arm', 'Device', '', 'Device', '1', 'Devices', 'otc', 280, 200, 0.15, ['Hypertension'], '', { isDrug: false }],
  ['Glucometer Strips', 'Device', '50s', 'Strips', '50s', 'Devices', 'otc', 150, 105, 0.15, ['Diabetes'], '', { isDrug: false }],
];

const SEED_VERSION = 4; // bump to force a re-seed on next deploy

async function runSeed() {
  await mongoose.connection.dropDatabase();
  console.log('Seeding', config.mongoUri);

  const org = await M.Organization.create({ name: 'MediCare Pharmacies', slug: 'medicare', plan: 'growth', seedVersion: SEED_VERSION, dpcRegistration: 'DPC-2024-004217', settings: { purchasing: 'central' },
    website: {
      headline: 'Caring for Ghana’s families since 2009',
      intro: 'Licensed community pharmacies in Accra, Kumasi and Takoradi. Talk to a pharmacist, fill your prescription, or order online for delivery.',
      about: 'MediCare Pharmacies started as a single shop on Oxford Street, Osu. Today our pharmacists serve thousands of families across three cities, with the same promise: genuine medicines, honest advice and a friendly face behind the counter.\n\nEvery prescription is checked by a registered pharmacist, and we keep our shelves stocked with trusted brands and affordable generics.',
      services: [
        { title: 'Prescriptions', text: 'Bring your prescription or upload a photo online. A pharmacist checks it and tells you how to take each medicine.' },
        { title: 'Free blood pressure checks', text: 'Walk in any day for a quick blood pressure and blood sugar check.' },
        { title: 'Malaria testing', text: 'Rapid malaria tests with results in 15 minutes and treatment advice.' },
        { title: 'Delivery', text: 'Order online and we deliver to your home or office, or pick up at your nearest branch.' },
      ],
      contact: { phone: '+233 30 222 1001', whatsapp: '+233 24 222 1001', email: 'hello@medicare.example' },
    } });
  const zones = (a, b, c) => [{ name: 'Within 3 km', fee: a, etaMins: 45 }, { name: '3 - 8 km', fee: b, etaMins: 75 }, { name: 'Outer city', fee: c, etaMins: 120 }];
  const [acc, ksi, tkd] = await M.Branch.create([
    { org: org._id, name: 'Accra Central', code: 'ACC', address: '14 Oxford Street, Osu, Accra', phone: '+233 30 222 1001', email: 'accra@medicare.example', licenseNumber: 'PC/RP/ACC/0412', licenseExpiry: day(300), superintendent: 'Pharm. Ama Mensah', openingHours: 'Mon-Sat 8am-9pm, Sun 10am-6pm', taxId: 'C0012345678', receiptHeader: 'MediCare Pharmacy - Accra Central', location: { lat: 5.556, lng: -0.1969 }, deliveryZones: zones(10, 18, 30) },
    { org: org._id, name: 'Kumasi Adum', code: 'KSI', address: '27 Adum High Street, Kumasi', phone: '+233 32 202 2002', email: 'kumasi@medicare.example', licenseNumber: 'PC/RP/KSI/0377', licenseExpiry: day(45), superintendent: 'Pharm. Kwame Boateng', openingHours: 'Mon-Sat 8am-8pm', taxId: 'C0012345679', receiptHeader: 'MediCare Pharmacy - Kumasi Adum', location: { lat: 6.6885, lng: -1.6244 }, deliveryZones: zones(8, 15, 25) },
    { org: org._id, name: 'Takoradi Market Circle', code: 'TKD', address: 'Market Circle, Takoradi', phone: '+233 31 202 3003', email: 'takoradi@medicare.example', licenseNumber: 'PC/RP/TKD/0291', licenseExpiry: day(400), superintendent: 'Pharm. Efua Quaye', openingHours: 'Mon-Sat 8am-7pm', taxId: 'C0012345680', receiptHeader: 'MediCare Pharmacy - Takoradi', location: { lat: 4.8845, lng: -1.7554 }, deliveryZones: zones(8, 14, 22) },
  ]);
  const branches = [acc, ksi, tkd];

  const mkUser = async (name, email, role, brs, extra = {}) => {
    const u = new M.User({ org: org._id, name, email, role, branches: brs.map((b) => b._id), phone: '+233 24 000 0000', ...extra });
    await u.setPassword(PASSWORD); await u.save(); return u;
  };
  const owner = await mkUser('Yaw Owusu (Owner)', 'owner@demo.com', 'owner', branches);
  const mgr = await mkUser('Akosua Manager', 'manager@demo.com', 'branch_manager', [acc]);
  const pharm = await mkUser('Pharm. Ama Mensah', 'pharmacist@demo.com', 'pharmacist', [acc, ksi], { pharmacistRegNo: 'PC/1/10442', pharmacistLicenseExpiry: day(200) });
  await mkUser('Kofi Technician', 'tech@demo.com', 'technician', [acc]);
  await mkUser('Esi Cashier', 'cashier@demo.com', 'cashier', [acc]);
  const store = await mkUser('Nii Store Officer', 'store@demo.com', 'store_officer', [acc]);
  await mkUser('Abena Accountant', 'accountant@demo.com', 'accountant', branches);
  await mkUser('Kojo Rider', 'rider@demo.com', 'dispatcher', [acc]);
  await mkUser('Ivy Auditor', 'auditor@demo.com', 'auditor', branches);
  await mkUser('Pharm. Kwame Boateng', 'pharmacist.kumasi@demo.com', 'pharmacist', [ksi], { pharmacistRegNo: 'PC/1/09871', pharmacistLicenseExpiry: day(120) });

  const products = [];
  for (const [brand, generic, strength, form, packSize, category, legalStatus, price, cost, taxRate, symptoms, barcode, extra = {}] of CATALOGUE) {
    products.push(await M.Product.create({
      org: org._id, brand, generic, strength, form, packSize, category, legalStatus, price, cost, taxRate, symptoms,
      directions: DIRECTIONS[brand]?.[0], warnings: DIRECTIONS[brand]?.[1] || undefined,
      barcode: barcode || String(6291000000000 + products.length * 17), manufacturer: pick(['Ernest Chemists', 'Kinapharma', 'GSK', 'Cipla', 'Pfizer', 'Letap']),
      fdaRegNo: `FDA/${String(10000 + products.length)}`, reorderLevel: legalStatus === 'controlled' ? 5 : 15,
      branchPrices: brand === 'Panadol Extra' ? [{ branch: tkd._id, price: 19 }] : [],
      imageUrl: IMAGES[brand] || null, ...extra,
    }));
  }

  const suppliers = await M.Supplier.create([
    { org: org._id, name: 'Kinapharma Distribution', contact: 'Sales desk', phone: '+233 30 277 0000', licenseNumber: 'PC/WS/0102', licenseExpiry: day(220), paymentTerms: 'Net 30', creditLimit: 80000, balance: 12400 },
    { org: org._id, name: 'Ernest Chemists Wholesale', contact: 'Accounts', phone: '+233 30 221 1111', licenseNumber: 'PC/WS/0077', licenseExpiry: day(40), paymentTerms: 'Net 14', creditLimit: 50000, balance: 5200 },
    { org: org._id, name: 'Danadams Pharmaceuticals', contact: 'Orders', phone: '+233 30 266 9000', licenseNumber: 'PC/WS/0150', licenseExpiry: day(500), paymentTerms: 'Cash on delivery', creditLimit: 0, balance: 0 },
  ]);

  // Stock: two or three batches per product per branch, with a few deliberate problems for the demo.
  for (const br of branches) {
    for (const [i, p] of products.entries()) {
      const batches = [[`B${rnd(1000, 9999)}`, day(rnd(150, 700)), rnd(20, 120)], [`B${rnd(1000, 9999)}`, day(rnd(100, 400)), rnd(10, 60)]];
      if (i % 9 === 3) batches.push([`B${rnd(1000, 9999)}`, day(rnd(12, 28)), rnd(5, 15)]); // expiring within 30 days
      if (i % 11 === 5) batches.push([`B${rnd(1000, 9999)}`, day(rnd(55, 85)), rnd(10, 30)]); // expiring within 90 days
      if (i === 8 && br === acc) batches.push(['OLD777', day(-12), 9]);                         // expired batch
      if (i % 13 === 7) { batches.length = 1; batches[0][2] = rnd(2, 9); }                    // low stock
      if (br === tkd && i === 5) batches.length = 0;                                           // out of stock at one branch
      for (const [batchNo, expiry, qty] of batches) {
        await addBatch({ org: org._id, branch: br._id, product: p._id, batchNo, expiry, qty, cost: p.cost, supplier: pick(suppliers)._id });
        if (p.legalStatus === 'controlled') {
          await registerEntry({ org: org._id, branch: br._id, product: p._id, productName: p.brand, type: 'receipt', qty, counterparty: suppliers[0].name, batchNo, pharmacist: pharm._id, pharmacistName: pharm.name, date: day(-40) });
        }
      }
    }
  }

  const customers = await M.Customer.create([
    { org: org._id, name: 'Kwabena Asante', phone: '+233241112233', email: 'kwabena@example.com', allergies: ['Penicillin'], conditions: ['Hypertension', 'High Cholesterol'], consent: { communications: true, healthData: true, at: day(-60) }, addresses: [{ label: 'Home', line: 'House 22, Ridge Road, Accra', digitalAddress: 'GA-123-4567', zone: 'Within 3 km' }, { label: 'Office', line: '5th Floor, Accra Mall, Spintex Road', digitalAddress: 'GA-456-7890', zone: '3 - 8 km' }], loyaltyPoints: 340 },
    { org: org._id, name: 'Adwoa Serwaa', phone: '+233205554433', email: 'adwoa@example.com', allergies: ['Sulfa'], conditions: ['Asthma'], consent: { communications: true, healthData: true, at: day(-30) }, addresses: [{ label: 'Home', line: 'Adum, Kumasi', zone: 'Within 3 km' }], loyaltyPoints: 80 },
    { org: org._id, name: 'Sunrise Clinic', phone: '+233302200100', email: 'accounts@sunrise.example', creditLimit: 5000, balance: 1350, consent: { communications: true, healthData: false, at: day(-90) }, addresses: [{ label: 'Clinic', line: '12 Cantonments Road, Accra', digitalAddress: 'GA-200-1234', zone: 'Within 3 km' }] },
    { org: org._id, name: 'Mohammed Issah', phone: '+233271234567', conditions: ['Diabetes', 'Hypertension'], consent: { communications: false, healthData: true, at: day(-10) }, addresses: [{ label: 'Home', line: 'Nima, Accra', digitalAddress: 'GA-789-0001', zone: '3 - 8 km' }], loyaltyPoints: 55 },
    { org: org._id, name: 'Efua Mensah', phone: '+233244987654', email: 'efua.mensah@example.com', allergies: ['Aspirin'], conditions: ['Pregnancy'], consent: { communications: true, healthData: true, at: day(-14) }, addresses: [{ label: 'Home', line: 'East Legon, Accra', digitalAddress: 'GA-321-5678', zone: '3 - 8 km' }], loyaltyPoints: 20 },
    { org: org._id, name: 'Kofi Boateng', phone: '+233208765432', email: 'kofi.b@example.com', allergies: [], conditions: ['Asthma', 'Allergy'], consent: { communications: true, healthData: true, at: day(-45) }, addresses: [{ label: 'Home', line: 'Kumasi, Nhyiaeso', zone: 'Within 3 km' }], loyaltyPoints: 160 },
    { org: org._id, name: 'Ama Darko', phone: '+233277001122', email: 'ama.darko@example.com', allergies: [], conditions: [], consent: { communications: true, healthData: false, at: day(-7) }, addresses: [{ label: 'Home', line: 'Takoradi, Anaji', zone: 'Within 3 km' }], loyaltyPoints: 0 },
    { org: org._id, name: 'St. Anthony Clinic', phone: '+233322045678', email: 'pharmacy@stanthony.example', creditLimit: 8000, balance: 2200, consent: { communications: true, healthData: false, at: day(-120) }, addresses: [{ label: 'Clinic', line: 'Adum, Kumasi', zone: 'Within 3 km' }] },
  ]);

  await M.Ledger.create({ org: org._id, customer: customers[2]._id, type: 'charge', amount: 1350, ref: 'Opening balance', by: owner._id });
  await M.Ledger.create({ org: org._id, customer: customers[7]._id, type: 'charge', amount: 2200, ref: 'Opening balance', by: owner._id });

  // Sales history for dashboards — 30 days, realistic volumes, mixed payments, loyalty redemptions
  const sellable = products.filter((p) => p.legalStatus !== 'controlled' && p.legalStatus !== 'prescription_only');
  const cashiers = [owner, mgr, pharm];
  let receiptSeq = 1;
  for (let d = 29; d >= 0; d--) {
    for (const br of branches) {
      // Accra busiest, weekends slightly higher, Takoradi quietest
      const isWeekend = [0, 6].includes(new Date(Date.now() - d * 86400000).getDay());
      const base = br === acc ? (isWeekend ? 22 : 16) : br === ksi ? (isWeekend ? 14 : 10) : (isWeekend ? 9 : 6);
      const count = rnd(base - 2, base + 4);
      for (let n = 0; n < count; n++) {
        const lines = Array.from({ length: rnd(1, 5) }, () => pick(sellable)).map((p) => ({ p, qty: rnd(1, 4) }));
        const useLoyalty = n % 15 === 0; // every ~15th sale redeems loyalty points
        const useDiscount = n % 8 === 0;  // every ~8th sale has a small discount
        const items = lines.map(({ p, qty }) => ({ product: p._id, name: `${p.brand} ${p.strength || ''}`.trim(), qty, unitPrice: p.price, taxRate: p.taxRate, tax: round2(p.price * qty * p.taxRate), lineTotal: round2(p.price * qty), cost: p.cost, lots: [] }));
        const subtotal = round2(items.reduce((s, i) => s + i.lineTotal, 0));
        const tax = round2(items.reduce((s, i) => s + i.tax, 0));
        const discount = useDiscount ? round2(subtotal * 0.05) : 0;
        const pointsRedeemed = useLoyalty ? 50 : 0;
        const loyaltyValue = round2(pointsRedeemed * 0.1);
        const total = round2(subtotal + tax - discount - loyaltyValue);
        const pointsEarned = round2(total * 0.1);
        const method = pick(['cash', 'cash', 'cash', 'momo', 'momo', 'card', 'credit']);
        const payments = useLoyalty
          ? [{ method: 'loyalty', amount: loyaltyValue }, { method: pick(['cash', 'momo']), amount: round2(total - loyaltyValue) }]
          : [{ method, amount: total }];
        const at = new Date(); at.setDate(at.getDate() - d); at.setHours(rnd(8, 20), rnd(0, 59));
        if (at > new Date()) at.setTime(Date.now() - rnd(1, 60) * 60000);
        await M.Sale.create({ org: org._id, branch: br._id, receiptNo: `R-${br.code}-${String(receiptSeq++).padStart(5, '0')}`, cashier: pick(cashiers)._id, channel: 'pos', items, subtotal, tax, discount, total, payments, pointsEarned, pointsRedeemed, createdAt: at });
      }
    }
  }

  const byBrand = (b) => products.find((p) => p.brand === b);

  await M.Prescription.create([
    // RX-001: pending verification — has allergy warning (Penicillin + Amoxil)
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-001', customer: customers[0]._id, patientName: customers[0].name, prescriber: { name: 'Dr. Kofi Adjei', regNo: 'MDC/12345', facility: 'Ridge Hospital' }, items: [{ product: byBrand('Amoxil')._id, name: 'Amoxil', dose: '500mg', frequency: '3 times daily', duration: '7 days', qty: 21 }, { product: byBrand('Amlodipine 5')._id, name: 'Amlodipine 5', dose: '5mg', frequency: 'Once daily', duration: '30 days', qty: 30 }], refillsAllowed: 1 },
    // RX-002: verified, ready to dispense — NHIS insurance
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-002', customer: customers[3]._id, patientName: customers[3].name, prescriber: { name: 'Dr. Efua Danso', regNo: 'MDC/22871', facility: 'Osu Polyclinic' }, items: [{ product: byBrand('Metformin 500')._id, name: 'Metformin 500', dose: '500mg', frequency: 'Twice daily', duration: '30 days', qty: 60 }, { product: byBrand('Amlodipine 5')._id, name: 'Amlodipine 5', dose: '5mg', frequency: 'Once daily', duration: '30 days', qty: 30 }], refillsAllowed: 2, insurance: { scheme: 'NHIS', memberNo: 'NHIS-0045123', copay: 2 }, status: 'verified', verifiedBy: pharm._id, verifiedAt: new Date() },
    // RX-003: controlled drug — verified, paper original sighted
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-003', patientName: 'Nana Ama Boakye', prescriber: { name: 'Dr. Yaa Frimpong', regNo: 'MDC/30112', facility: 'Korle Bu Teaching Hospital', address: 'Korle Bu, Accra' }, items: [{ product: byBrand('Diazepam 5')._id, name: 'Diazepam 5', dose: '5mg', frequency: 'At night', duration: '14 days', qty: 14 }], hasControlled: true, paperOriginalSeen: true, status: 'verified', verifiedBy: pharm._id, verifiedAt: new Date() },
    // RX-004: online upload — pending review
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-004', customer: customers[1]._id, patientName: customers[1].name, prescriber: { name: 'As on uploaded prescription' }, source: 'online', items: [{ product: byBrand('Ciprofloxacin 500')._id, name: 'Ciprofloxacin 500', qty: 10 }] },
    // RX-005: partially dispensed — 1 refill used
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-005', customer: customers[4]._id, patientName: customers[4].name, prescriber: { name: 'Dr. Samuel Acheampong', regNo: 'MDC/18844', facility: 'Legon Hospital' }, items: [{ product: byBrand('Salbutamol Inhaler')._id, name: 'Salbutamol Inhaler', dose: '2 puffs', frequency: 'As needed', duration: '90 days', qty: 2, dispensedQty: 1 }], refillsAllowed: 2, refillsUsed: 1, status: 'partial', verifiedBy: pharm._id, verifiedAt: day(-30) },
    // RX-006: Kumasi branch — verified, diabetes management
    { org: org._id, branch: ksi._id, rxNo: 'RX-DEMO-006', customer: customers[5]._id, patientName: customers[5].name, prescriber: { name: 'Dr. Abena Frimpong', regNo: 'MDC/27654', facility: 'Komfo Anokye Teaching Hospital' }, items: [{ product: byBrand('Metformin 500')._id, name: 'Metformin 500', dose: '500mg', frequency: 'Twice daily', duration: '30 days', qty: 60 }, { product: byBrand('Glibenclamide 5')._id, name: 'Glibenclamide 5', dose: '5mg', frequency: 'Once daily', duration: '30 days', qty: 30 }], refillsAllowed: 3, insurance: { scheme: 'NHIS', memberNo: 'NHIS-0078456', copay: 0 }, status: 'verified', verifiedBy: pharm._id, verifiedAt: new Date() },
    // RX-007: rejected — incomplete prescriber details
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-007', patientName: 'Unknown Patient', prescriber: { name: 'Dr. Unknown' }, items: [{ product: byBrand('Tramadol 50')._id, name: 'Tramadol 50', qty: 20 }], hasControlled: true, status: 'rejected', rejectedReason: 'Prescriber registration number missing and paper original not presented.' },
  ]);

  // Reminder plan for Kwabena (consented, on Amlodipine long-term)
  await M.ReminderPlan.create({ org: org._id, customer: customers[0]._id, branch: acc._id, product: byBrand('Amlodipine 5')._id, medicine: 'Amlodipine 5mg', dose: '1 tablet', times: ['08:00'], startDate: day(-3), endDate: day(27), refill: true, createdBy: pharm.name });
  // Reminder plan for Efua (pregnant, on Folic Acid)
  await M.ReminderPlan.create({ org: org._id, customer: customers[4]._id, branch: acc._id, product: byBrand('Folic Acid 5mg')._id, medicine: 'Folic Acid 5mg', dose: '1 tablet', times: ['07:00'], startDate: day(-14), endDate: day(76), refill: false, createdBy: pharm.name });

  const rxOrderRx = await M.Prescription.findOne({ org: org._id, rxNo: 'RX-DEMO-004' });
  const mkItem = (p, qty, rx = false) => ({ product: p._id, name: `${p.brand} ${p.strength || ''}`.trim(), qty, unitPrice: p.price, taxRate: p.taxRate, requiresRx: rx });
  const rider = await M.User.findOne({ org: org._id, role: 'dispatcher' });

  await M.Order.create([
    // received — just placed, awaiting review
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-001', customer: customers[0]._id, items: [mkItem(byBrand('Panadol Extra'), 2), mkItem(byBrand('ORS Sachets'), 3)], fulfilment: 'delivery', address: { line: 'House 22, Ridge Road, Accra', digitalAddress: 'GA-123-4567', zone: 'Within 3 km' }, deliveryFee: 10, subtotal: 81, tax: 0, total: 91, payment: { method: 'momo', status: 'paid', reference: 'PAY-DEMO1' }, status: 'received', history: [{ status: 'received', by: 'customer', note: 'Placed via portal' }] },
    // pending_review — has prescription attachment
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-002', customer: customers[1]._id, prescription: rxOrderRx._id, items: [mkItem(byBrand('Ciprofloxacin 500'), 10, true), mkItem(byBrand('Vitamin C 1000'), 1)], fulfilment: 'pickup', deliveryFee: 0, subtotal: 75, tax: 0, total: 75, payment: { method: 'card', status: 'paid', reference: 'PAY-DEMO2' }, status: 'pending_review', history: [{ status: 'received', by: 'customer' }, { status: 'pending_review', by: 'Esi Cashier', note: 'Prescription needs pharmacist review' }] },
    // approved — stock reserved, awaiting packing
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-003', customer: customers[3]._id, items: [mkItem(byBrand('Metformin 500'), 2), mkItem(byBrand('Glucometer Strips'), 1)], fulfilment: 'delivery', address: { line: 'Nima, Accra', digitalAddress: 'GA-789-0001', zone: '3 - 8 km' }, deliveryFee: 18, subtotal: 200, tax: 0, total: 218, payment: { method: 'momo', status: 'paid', reference: 'PAY-DEMO3' }, status: 'approved', stockReserved: true, history: [{ status: 'received', by: 'customer' }, { status: 'approved', by: 'Pharm. Ama Mensah', note: 'Stock confirmed' }] },
    // packed — ready for rider pickup
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-004', customer: customers[4]._id, items: [mkItem(byBrand('Folic Acid 5mg'), 2), mkItem(byBrand('Multivitamin Daily'), 1), mkItem(byBrand('Ferrous Sulphate'), 1)], fulfilment: 'delivery', address: { line: 'East Legon, Accra', digitalAddress: 'GA-321-5678', zone: '3 - 8 km' }, deliveryFee: 18, subtotal: 68, tax: 0, total: 86, payment: { method: 'cod', status: 'pending' }, status: 'packed', stockReserved: true, history: [{ status: 'received', by: 'customer' }, { status: 'approved', by: 'Pharm. Ama Mensah' }, { status: 'packed', by: 'Kofi Technician', note: 'Packed and labelled' }] },
    // out_for_delivery — rider assigned, delivery code set
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-005', customer: customers[5]._id, items: [mkItem(byBrand('Cetirizine 10'), 2), mkItem(byBrand('Benylin Cough Syrup'), 1)], fulfilment: 'delivery', address: { line: 'Kumasi, Nhyiaeso', zone: 'Within 3 km' }, deliveryFee: 8, subtotal: 62, tax: 0, total: 70, payment: { method: 'momo', status: 'paid', reference: 'PAY-DEMO5' }, status: 'out_for_delivery', stockReserved: true, deliveryCode: '7842', rider: { user: rider._id, name: 'Kojo Rider', phone: '+233244000001', external: false }, history: [{ status: 'received', by: 'customer' }, { status: 'approved', by: 'Pharm. Ama Mensah' }, { status: 'packed', by: 'Kofi Technician' }, { status: 'out_for_delivery', by: 'Kojo Rider', note: 'En route' }] },
    // delivered — completed with proof
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-006', customer: customers[0]._id, items: [mkItem(byBrand('Vitamin C 1000'), 2), mkItem(byBrand('Strepsils Lozenges'), 1)], fulfilment: 'delivery', address: { line: 'House 22, Ridge Road, Accra', digitalAddress: 'GA-123-4567', zone: 'Within 3 km' }, deliveryFee: 10, subtotal: 100, tax: 0, total: 110, payment: { method: 'momo', status: 'paid', reference: 'PAY-DEMO6' }, status: 'delivered', stockReserved: false, proof: { recipient: 'Kwabena Asante', at: day(-1) }, history: [{ status: 'received', by: 'customer' }, { status: 'approved', by: 'Pharm. Ama Mensah' }, { status: 'packed', by: 'Kofi Technician' }, { status: 'out_for_delivery', by: 'Kojo Rider' }, { status: 'delivered', by: 'Kojo Rider', note: 'Received by customer' }] },
    // cancelled — customer changed mind before packing
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-007', customer: customers[6]._id, items: [mkItem(byBrand('Digital Thermometer'), 1)], fulfilment: 'pickup', deliveryFee: 0, subtotal: 45, tax: 6.75, total: 51.75, payment: { method: 'cod', status: 'pending' }, status: 'cancelled', stockReserved: false, history: [{ status: 'received', by: 'customer' }, { status: 'cancelled', by: 'customer', note: 'Customer cancelled before packing' }] },
    // Kumasi branch — pickup, approved
    { org: org._id, branch: ksi._id, orderNo: 'ON-DEMO-008', customer: customers[5]._id, items: [mkItem(byBrand('Omeprazole 20'), 2), mkItem(byBrand('Gaviscon'), 1)], fulfilment: 'pickup', deliveryFee: 0, subtotal: 104, tax: 0, total: 104, payment: { method: 'card', status: 'paid', reference: 'PAY-DEMO8' }, status: 'approved', stockReserved: true, history: [{ status: 'received', by: 'customer' }, { status: 'approved', by: 'Pharm. Kwame Boateng' }] },
  ]);

  // Promotions: percent, fixed and BOGO across categories, branches and channels
  await M.Promotion.create([
    // Sitewide OTC weekend deal (online only)
    { org: org._id, name: 'Weekend OTC Sale', type: 'percent', value: 10, categories: ['Pain & Fever', 'Allergy & Cold', 'Stomach & Digestion'], branches: [], channel: 'online', startsAt: day(0), endsAt: day(2), active: true },
    // Vitamins bundle push (all branches, both channels)
    { org: org._id, name: 'Vitamins Combo Deal', type: 'percent', value: 15, categories: ['Vitamins'], branches: [], channel: 'both', startsAt: day(-7), endsAt: day(14), active: true },
    // GHS 5 off Panadol Extra at Accra (POS only, drives footfall)
    { org: org._id, name: 'Panadol Extra In-Store Offer', type: 'fixed', value: 5, products: [byBrand('Panadol Extra')._id], branches: [acc._id], channel: 'pos', startsAt: day(-3), endsAt: day(4), active: true },
    // Buy 2 get 1 free on ORS Sachets (all branches, both channels — malaria/diarrhoea season)
    { org: org._id, name: 'ORS Buy 2 Get 1 Free', type: 'bogo', buyQty: 2, getQty: 1, products: [byBrand('ORS Sachets')._id], branches: [], channel: 'both', startsAt: day(-5), endsAt: day(10), active: true },
    // Devices clearance at Takoradi (POS only)
    { org: org._id, name: 'Takoradi Devices Clearance', type: 'percent', value: 20, categories: ['Devices'], branches: [tkd._id], channel: 'pos', startsAt: day(-1), endsAt: day(6), active: true },
    // Expired promo (shows in history)
    { org: org._id, name: 'New Year Wellness Promo', type: 'percent', value: 12, categories: ['Vitamins', 'Cosmetics'], branches: [], channel: 'both', startsAt: day(-30), endsAt: day(-15), active: false },
  ]);
  await M.PurchaseOrder.create({ org: org._id, branch: acc._id, poNo: 'PO-DEMO-001', supplier: suppliers[0]._id, items: [{ product: byBrand('Amoxil')._id, name: 'Amoxil', qty: 200, cost: 28, receivedQty: 200 }, { product: byBrand('Coartem 80/480')._id, name: 'Coartem 80/480', qty: 150, cost: 34, receivedQty: 150 }], total: round2(200 * 28 + 150 * 34), status: 'received', createdBy: store._id, approvedBy: mgr._id, receipts: [{ at: day(-10), by: store._id, invoiceNo: 'INV-KP-20241', invoiceTotal: round2(200 * 28 + 150 * 34), receivedValue: round2(200 * 28 + 150 * 34), mismatch: false }] });
  await M.PurchaseOrder.create({ org: org._id, branch: acc._id, poNo: 'PO-DEMO-002', supplier: suppliers[1]._id, items: [{ product: byBrand('Gaviscon')._id, name: 'Gaviscon', qty: 60, cost: 31, receivedQty: 50 }, { product: byBrand('Omeprazole 20')._id, name: 'Omeprazole 20', qty: 100, cost: 15, receivedQty: 100 }], total: round2(60 * 31 + 100 * 15), status: 'partial', createdBy: store._id, approvedBy: mgr._id, receipts: [{ at: day(-5), by: store._id, invoiceNo: 'INV-EC-8821', invoiceTotal: round2(50 * 31 + 100 * 15), receivedValue: round2(50 * 31 + 100 * 15), mismatch: true }] });
  await M.PurchaseOrder.create({ org: org._id, branch: acc._id, poNo: 'PO-DEMO-003', supplier: suppliers[0]._id, items: [{ product: byBrand('Ciprofloxacin 500')._id, name: 'Ciprofloxacin 500', qty: 120, cost: 24 }, { product: byBrand('Metronidazole 400')._id, name: 'Metronidazole 400', qty: 200, cost: 11 }], total: round2(120 * 24 + 200 * 11), status: 'sent', createdBy: store._id, approvedBy: mgr._id });
  await M.PurchaseOrder.create({ org: org._id, branch: acc._id, poNo: 'PO-DEMO-004', supplier: suppliers[2]._id, items: [{ product: byBrand('Insulin Mixtard 30')._id, name: 'Insulin Mixtard 30', qty: 30, cost: 85 }, { product: byBrand('Glucometer Strips')._id, name: 'Glucometer Strips', qty: 50, cost: 105 }], total: round2(30 * 85 + 50 * 105), status: 'approved', createdBy: store._id, approvedBy: mgr._id });
  await M.PurchaseOrder.create({ org: org._id, branch: acc._id, poNo: 'PO-DEMO-005', supplier: suppliers[1]._id, items: [{ product: byBrand('Panadol Extra')._id, name: 'Panadol Extra', qty: 300, cost: 11 }, { product: byBrand('Ibuprofen 400')._id, name: 'Ibuprofen 400', qty: 150, cost: 13 }], total: round2(300 * 11 + 150 * 13), status: 'draft', createdBy: store._id });
  await M.PurchaseOrder.create({ org: org._id, branch: ksi._id, poNo: 'PO-DEMO-006', supplier: suppliers[0]._id, items: [{ product: byBrand('Coartem 80/480')._id, name: 'Coartem 80/480', qty: 100, cost: 34 }, { product: byBrand('Lonart DS')._id, name: 'Lonart DS', qty: 80, cost: 26 }], total: round2(100 * 34 + 80 * 26), status: 'sent', createdBy: store._id, approvedBy: owner._id });
  await M.PurchaseOrder.create({ org: org._id, branch: tkd._id, poNo: 'PO-DEMO-007', supplier: suppliers[2]._id, items: [{ product: byBrand('Amoxil')._id, name: 'Amoxil', qty: 100, cost: 28 }, { product: byBrand('Augmentin 625')._id, name: 'Augmentin 625', qty: 50, cost: 66 }], total: round2(100 * 28 + 50 * 66), status: 'approved', createdBy: store._id, approvedBy: owner._id });

  // Stock transfers: requested, in transit, received, rejected
  await M.StockTransfer.create({ org: org._id, ref: 'TR-DEMO-001', from: acc._id, to: tkd._id, status: 'requested', items: [{ product: byBrand('Amoxil')._id, name: 'Amoxil', qty: 40 }], requestedBy: owner._id, note: 'Takoradi out of Amoxil' });
  await M.StockTransfer.create({ org: org._id, ref: 'TR-DEMO-002', from: acc._id, to: ksi._id, status: 'in_transit', items: [{ product: byBrand('Panadol Extra')._id, name: 'Panadol Extra', qty: 60 }, { product: byBrand('ORS Sachets')._id, name: 'ORS Sachets', qty: 30 }], requestedBy: mgr._id, approvedBy: owner._id, note: 'Kumasi running low on OTC stock' });
  await M.StockTransfer.create({ org: org._id, ref: 'TR-DEMO-003', from: ksi._id, to: tkd._id, status: 'received', items: [{ product: byBrand('Coartem 80/480')._id, name: 'Coartem 80/480', qty: 20, receivedQty: 20 }], requestedBy: owner._id, approvedBy: owner._id, receivedBy: store._id, note: 'Malaria season top-up' });
  await M.StockTransfer.create({ org: org._id, ref: 'TR-DEMO-004', from: tkd._id, to: acc._id, status: 'rejected', items: [{ product: byBrand('Ibuprofen 400')._id, name: 'Ibuprofen 400', qty: 50 }], requestedBy: store._id, note: 'Rejected: Takoradi also low on stock' });

  console.log('\nDemo ready. Sign in with password', PASSWORD);
  console.log('  owner@demo.com           Owner, all branches');
  console.log('  manager@demo.com         Branch manager (Accra)');
  console.log('  pharmacist@demo.com      Pharmacist (Accra + Kumasi)');
  console.log('  cashier@demo.com         Cashier (Accra)');
  console.log('  store@demo.com           Store officer, tech@, accountant@, rider@, auditor@');
  console.log('Customer portal: /shop/medicare   (OTP code is', config.otpDemoCode + ')');
}

module.exports = { runSeed, SEED_VERSION };

// Run directly: node src/seed.js
if (require.main === module) {
  if (config.isProd && process.env.SEED_CONFIRM !== 'wipe-and-seed') {
    console.error('Refusing to seed: this deletes ALL data in', config.mongoUri, '\nSet SEED_CONFIRM=wipe-and-seed to seed a fresh demo database.');
    process.exit(1);
  }
  mongoose.connect(config.mongoUri)
    .then(() => runSeed())
    .then(() => mongoose.disconnect())
    .catch((e) => { console.error(e); process.exit(1); });
}
