// Basket pricing shared by the till, the customer portal and order edits: promotions (FR-POS-04),
// a manual discount, and tax on what is actually charged. Pure functions, no database access.
const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const NO_PROMO = ['prescription_only', 'controlled']; // medicines on prescription are never discounted by promotion

const promoApplies = (promo, line, { channel, branch, now }) => {
  if (!promo.active) return false;
  if (promo.startsAt && new Date(promo.startsAt) > now) return false;
  if (promo.endsAt && new Date(promo.endsAt) < now) return false;
  if (promo.channel && promo.channel !== 'both' && promo.channel !== channel) return false;
  if (promo.branches?.length && !promo.branches.some((b) => String(b) === String(branch))) return false;
  if (NO_PROMO.includes(line.p.legalStatus)) return false;
  const products = promo.products || []; const categories = promo.categories || [];
  if (products.length || categories.length) {
    const byProduct = products.some((x) => String(x) === String(line.p._id));
    const byCategory = categories.includes(line.p.category);
    if (!byProduct && !byCategory) return false;
  }
  return line.qty >= (promo.minQty || 1);
};

const promoDiscountFor = (promo, line, unitPrice) => {
  const gross = unitPrice * line.qty;
  if (promo.type === 'percent') return Math.min(gross, gross * (promo.value / 100));
  if (promo.type === 'fixed') return Math.min(unitPrice, promo.value) * line.qty; // amount off each unit
  if (promo.type === 'bogo') {
    const buy = promo.buyQty || 1; const get = promo.getQty || 1;
    return Math.floor(line.qty / (buy + get)) * get * unitPrice;
  }
  return 0;
};

// Best single promotion per line; promotions do not stack.
const bestPromo = (promos, line, unitPrice, ctx) => {
  let best = null;
  for (const promo of promos || []) {
    if (!promoApplies(promo, line, ctx)) continue;
    const d = round2(promoDiscountFor(promo, line, unitPrice));
    if (d > 0 && (!best || d > best.amount)) best = { amount: d, name: promo.name, id: promo._id };
  }
  return best;
};

// lines: [{ p, qty, unitPrice }]. Returns per-line pricing and totals.
const priceBasket = (lines, { promos = [], manualDiscount = 0, channel = 'pos', branch, now = new Date() } = {}) => {
  const priced = lines.map((l) => {
    const gross = round2(l.unitPrice * l.qty);
    const promo = bestPromo(promos, l, l.unitPrice, { channel, branch, now });
    return { ...l, gross, promoDiscount: promo?.amount || 0, promoName: promo?.name, promoId: promo?.id };
  });
  const subtotal = round2(priced.reduce((s, i) => s + i.gross, 0));
  const promoTotal = round2(priced.reduce((s, i) => s + i.promoDiscount, 0));
  const afterPromo = round2(subtotal - promoTotal);
  const manual = round2(Math.min(Math.max(0, Number(manualDiscount) || 0), afterPromo));
  let tax = 0;
  priced.forEach((i) => {
    const base = i.gross - i.promoDiscount;
    const share = afterPromo ? base / afterPromo : 0;
    i.manualDiscount = round2(manual * share);
    i.taxable = round2(base - i.manualDiscount);
    i.tax = round2(i.taxable * (i.p.taxRate || 0));
    i.net = round2(i.taxable + i.tax); // what the customer actually pays for this line
    tax += i.tax;
  });
  tax = round2(tax);
  return { lines: priced, subtotal, promoDiscount: promoTotal, manualDiscount: manual, afterPromo, tax, total: round2(afterPromo - manual + tax) };
};

module.exports = { priceBasket, bestPromo, round2 };
