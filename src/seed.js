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

// [brand, generic, strength, form, pack, category, legal, price, cost, tax, symptoms, barcode, extra]
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

(async () => {
  await mongoose.connect(config.mongoUri);
  await mongoose.connection.dropDatabase();
  console.log('Seeding', config.mongoUri);

  const org = await M.Organization.create({ name: 'MediCare Pharmacies', slug: 'medicare', plan: 'growth', dpcRegistration: 'DPC-2024-004217', settings: { purchasing: 'central' } });
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
      barcode: barcode || String(6291000000000 + products.length * 17), manufacturer: pick(['Ernest Chemists', 'Kinapharma', 'GSK', 'Cipla', 'Pfizer', 'Letap']),
      fdaRegNo: `FDA/${String(10000 + products.length)}`, reorderLevel: legalStatus === 'controlled' ? 5 : 15,
      branchPrices: brand === 'Panadol Extra' ? [{ branch: tkd._id, price: 19 }] : [], ...extra,
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
    { org: org._id, name: 'Kwabena Asante', phone: '+233241112233', email: 'kwabena@example.com', allergies: ['Penicillin'], conditions: ['Hypertension'], consent: { communications: true, healthData: true, at: day(-60) }, addresses: [{ label: 'Home', line: 'House 22, Ridge Road, Accra', digitalAddress: 'GA-123-4567', zone: 'Within 3 km' }], loyaltyPoints: 120 },
    { org: org._id, name: 'Adwoa Serwaa', phone: '+233205554433', email: 'adwoa@example.com', allergies: [], consent: { communications: true, healthData: true, at: day(-30) }, addresses: [{ label: 'Home', line: 'Adum, Kumasi', zone: 'Within 3 km' }] },
    { org: org._id, name: 'Sunrise Clinic', phone: '+233302200100', email: 'accounts@sunrise.example', creditLimit: 5000, balance: 1350, consent: { communications: true, healthData: false, at: day(-90) } },
    { org: org._id, name: 'Mohammed Issah', phone: '+233271234567', conditions: ['Diabetes'], consent: { communications: false, healthData: true, at: day(-10) } },
  ]);

  // Sales history for dashboards (stock is not touched; this is back-dated reporting data).
  const sellable = products.filter((p) => p.legalStatus !== 'controlled' && p.legalStatus !== 'prescription_only');
  const cashiers = [owner, mgr, pharm];
  for (let d = 13; d >= 0; d--) {
    for (const br of branches) {
      const count = rnd(br === acc ? 12 : 6, br === acc ? 24 : 14);
      for (let n = 0; n < count; n++) {
        const lines = Array.from({ length: rnd(1, 4) }, () => pick(sellable)).map((p) => ({ p, qty: rnd(1, 3) }));
        const items = lines.map(({ p, qty }) => ({ product: p._id, name: `${p.brand} ${p.strength || ''}`.trim(), qty, unitPrice: p.price, taxRate: p.taxRate, tax: round2(p.price * qty * p.taxRate), lineTotal: round2(p.price * qty), cost: p.cost, lots: [] }));
        const subtotal = round2(items.reduce((s, i) => s + i.lineTotal, 0));
        const tax = round2(items.reduce((s, i) => s + i.tax, 0));
        const at = new Date(); at.setDate(at.getDate() - d); at.setHours(rnd(8, 19), rnd(0, 59));
        if (at > new Date()) at.setTime(Date.now() - rnd(1, 60) * 60000);
        await M.Sale.create({ org: org._id, branch: br._id, receiptNo: `R-SEED-${d}-${br.code}-${n}`, cashier: pick(cashiers)._id, channel: 'pos', items, subtotal, tax, total: round2(subtotal + tax), payments: [{ method: pick(['cash', 'cash', 'momo', 'card']), amount: round2(subtotal + tax) }], createdAt: at });
      }
    }
  }

  const byBrand = (b) => products.find((p) => p.brand === b);
  // Prescriptions: one to verify (allergy warning!), one ready to dispense, one controlled.
  await M.Prescription.create([
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-001', customer: customers[0]._id, patientName: customers[0].name, prescriber: { name: 'Dr. Kofi Adjei', regNo: 'MDC/12345', facility: 'Ridge Hospital' }, items: [{ product: byBrand('Amoxil')._id, name: 'Amoxil', dose: '500mg', frequency: '3 times daily', duration: '7 days', qty: 21 }, { product: byBrand('Amlodipine 5')._id, name: 'Amlodipine 5', dose: '5mg', frequency: 'Once daily', duration: '30 days', qty: 30 }], refillsAllowed: 1 },
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-002', customer: customers[3]._id, patientName: customers[3].name, prescriber: { name: 'Dr. Efua Danso', regNo: 'MDC/22871', facility: 'Osu Polyclinic' }, items: [{ product: byBrand('Metformin 500')._id, name: 'Metformin 500', dose: '500mg', frequency: 'Twice daily', duration: '5 days', qty: 10 }], refillsAllowed: 1, insurance: { scheme: 'NHIS', memberNo: 'NHIS-0045123', copay: 2 }, status: 'verified', verifiedBy: pharm._id, verifiedAt: new Date() },
    { org: org._id, branch: acc._id, rxNo: 'RX-DEMO-003', patientName: 'Nana Ama Boakye', prescriber: { name: 'Dr. Yaa Frimpong', regNo: 'MDC/30112', facility: 'Korle Bu Teaching Hospital', address: 'Korle Bu, Accra' }, items: [{ product: byBrand('Diazepam 5')._id, name: 'Diazepam 5', dose: '5mg', frequency: 'At night', duration: '14 days', qty: 14 }], hasControlled: true, paperOriginalSeen: true, status: 'verified', verifiedBy: pharm._id, verifiedAt: new Date() },
  ]);

  // Online orders in different states.
  const rxOrderRx = await M.Prescription.create({ org: org._id, branch: acc._id, rxNo: 'RX-DEMO-004', customer: customers[1]._id, patientName: customers[1].name, prescriber: { name: 'As on uploaded prescription' }, source: 'online', items: [{ product: byBrand('Ciprofloxacin 500')._id, name: 'Ciprofloxacin 500', qty: 10 }] });
  const mkItem = (p, qty, rx = false) => ({ product: p._id, name: `${p.brand} ${p.strength || ''}`.trim(), qty, unitPrice: p.price, taxRate: p.taxRate, requiresRx: rx });
  await M.Order.create([
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-001', customer: customers[0]._id, items: [mkItem(byBrand('Panadol Extra'), 2), mkItem(byBrand('ORS Sachets'), 3)], fulfilment: 'delivery', address: { line: 'House 22, Ridge Road, Accra', digitalAddress: 'GA-123-4567', zone: 'Within 3 km' }, deliveryFee: 10, etaMins: 45, subtotal: 81, tax: 0, total: 91, payment: { method: 'momo', status: 'paid', reference: 'PAY-DEMO1' }, status: 'received', history: [{ status: 'received', by: 'customer' }] },
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-002', customer: customers[1]._id, prescription: rxOrderRx._id, items: [mkItem(byBrand('Ciprofloxacin 500'), 10, true), mkItem(byBrand('Vitamin C 1000'), 1)], fulfilment: 'pickup', deliveryFee: 0, subtotal: 75, tax: 0, total: 75, payment: { method: 'card', status: 'paid', reference: 'PAY-DEMO2' }, status: 'pending_review', history: [{ status: 'pending_review', by: 'customer' }] },
    { org: org._id, branch: acc._id, orderNo: 'ON-DEMO-003', customer: customers[3]._id, items: [mkItem(byBrand('Glucometer Strips'), 1)], fulfilment: 'delivery', address: { line: 'Labone, Accra', zone: '3 - 8 km' }, deliveryFee: 18, etaMins: 75, subtotal: 150, tax: 22.5, total: 190.5, payment: { method: 'cod', status: 'pending' }, status: 'packed', stockReserved: false, history: [{ status: 'received', by: 'customer' }, { status: 'approved', by: 'Pharm. Ama Mensah' }, { status: 'packed', by: 'Kofi Technician' }] },
  ]);

  // Purchase order awaiting receipt and a transfer request.
  await M.PurchaseOrder.create({ org: org._id, branch: acc._id, poNo: 'PO-DEMO-001', supplier: suppliers[0]._id, items: [{ product: byBrand('Amoxil')._id, name: 'Amoxil', qty: 200, cost: 28 }, { product: byBrand('Coartem 80/480')._id, name: 'Coartem 80/480', qty: 150, cost: 34 }], total: round2(200 * 28 + 150 * 34), status: 'sent', createdBy: store._id, approvedBy: mgr._id });
  await M.PurchaseOrder.create({ org: org._id, branch: acc._id, poNo: 'PO-DEMO-002', supplier: suppliers[1]._id, items: [{ product: byBrand('Gaviscon')._id, name: 'Gaviscon', qty: 60, cost: 31 }], total: 1860, status: 'draft', createdBy: store._id });
  await M.StockTransfer.create({ org: org._id, ref: 'TR-DEMO-001', from: acc._id, to: tkd._id, status: 'requested', items: [{ product: byBrand('Amoxil')._id, name: 'Amoxil', qty: 40 }], requestedBy: owner._id, note: 'Takoradi out of Amoxil' });

  console.log('\nDemo ready. Sign in with password', PASSWORD);
  console.log('  owner@demo.com           Owner, all branches');
  console.log('  manager@demo.com         Branch manager (Accra)');
  console.log('  pharmacist@demo.com      Pharmacist (Accra + Kumasi)');
  console.log('  cashier@demo.com         Cashier (Accra)');
  console.log('  store@demo.com           Store officer, tech@, accountant@, rider@, auditor@');
  console.log('Customer portal: /shop/medicare   (OTP code is', config.otpDemoCode + ')');
  await mongoose.disconnect();
})().catch((e) => { console.error(e); process.exit(1); });
